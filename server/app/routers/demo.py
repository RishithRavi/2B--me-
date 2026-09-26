"""Demo / admin endpoints (§5.3, §13 expo mode). Require DEMO_MODE=1.

Every call runs inside `audit.acting(<principal handle>)`, so the org audit trail (§2.4) attributes markers,
resets and re-arms to the person who pressed the button.
"""

from __future__ import annotations

import secrets
from uuid import UUID

from fastapi import APIRouter, HTTPException

from app.auth import DemoAdmin, DemoPrincipal, Principal
from app.core import voice_demo
from app.core.audit import ORG_DOMAIN, acting
from app.core.hub import DeviceRuntime
from app.core.registry import token_hash
from app.core.runtime import rt
from twobme_common.types import (
    DemoDeviceIn,
    DemoLabelIn,
    DemoMarkerIn,
    DemoRearmIn,
    DemoVoiceOutcomeIn,
    MarkerPoint,
    OkOut,
    OrgEmployee,
    OrgSeedIn,
    OrgSeedOut,
    PurgeSessionIn,
    RedteamActiveOut,
    Snapshot,
    TrustLive,
)

# org demo (§2.4): pseudonymous employees streamed through the real hub by scripts/core_org_demo.py
ORG_TEAMS = ("Finance", "Engineering", "Sales", "Support", "Operations", "Legal", "People")
ORG_DEVICES = (("MacBook Pro", "macOS 26.4", "trackpad"), ("ThinkPad X1", "Windows 11", "mouse"),
               ("Mac mini", "macOS 26.4", "mouse"), ("MacBook Air", "macOS 26.4", "trackpad"),
               ("Dell XPS 13", "Windows 11", "trackpad"), ("Surface Laptop 7", "Windows 11", "trackpad"))
UNUSABLE_PW = "!org-demo:no-login"  # not an argon2 hash: verify_password() always fails

router = APIRouter(prefix="/demo", tags=["demo"])


def _drt(p: Principal, device_id: UUID) -> DeviceRuntime:
    r = rt()
    dev = r.registry.devices.get(device_id)
    if dev is None or not (p.is_admin or dev.user_id == p.user.id):
        raise HTTPException(404, "unknown device")
    return r.hub.rt(dev)


@router.post("/label", response_model=OkOut)
async def label(body: DemoLabelIn, p: DemoPrincipal) -> OkOut:
    with acting(p.user.handle):
        await rt().hub.set_label(_drt(p, body.device_id), body.label, body.actor)
    return OkOut()


@router.post("/marker", response_model=MarkerPoint)
async def marker(body: DemoMarkerIn, p: DemoPrincipal) -> MarkerPoint:
    with acting(p.user.handle):
        return await rt().hub.add_marker(_drt(p, body.device_id), body.label, None, body.text, source="dashboard")


@router.post("/reset", response_model=Snapshot)
async def reset(body: DemoDeviceIn, p: DemoAdmin) -> Snapshot:
    with acting(p.user.handle):
        return await rt().hub.reset(_drt(p, body.device_id), by=f"dashboard:{p.user.handle}")


@router.post("/rearm", response_model=TrustLive)
async def rearm(body: DemoRearmIn, p: DemoAdmin) -> TrustLive:
    with acting(p.user.handle):
        return await rt().hub.rearm(_drt(p, body.device_id), body.confidence)


@router.get("/redteam/active-challenge", response_model=RedteamActiveOut | None)
async def redteam_active(device_id: UUID, p: DemoAdmin) -> RedteamActiveOut | None:
    """For the live attack tool (C2.7). Every read is logged as an anomaly of kind `redteam_tool`."""
    r = rt()
    drt = _drt(p, device_id)
    ch = await r.issuer.open_for_device(device_id)
    r.hub.anomaly(drt, "redteam_tool", 1, None, None, action="active_challenge_read",
                  challenge_id=ch.challenge_id if ch else None)
    if ch is None:
        return None
    return RedteamActiveOut(challenge_id=ch.challenge_id, phrase=ch.phrase, status=ch.status)


@router.post("/purge-session", response_model=OkOut)
async def purge_session(body: PurgeSessionIn, p: DemoAdmin) -> OkOut:
    """Remove volunteer test data (§10 optional fresh-attacker trial)."""
    r = rt()
    if not r.db.up:
        raise HTTPException(503, "Tiger is down")
    for sql in (
        "DELETE FROM feature_blocks WHERE session_id = $1",
        "DELETE FROM trust_ticks WHERE session_id = $1",
        "DELETE FROM markers WHERE session_id = $1",
        "UPDATE sessions SET status='purged', ended_reason='purged', ended_at=coalesce(ended_at, now()) WHERE id = $1",
    ):
        if not await r.db.execute(sql, body.session_id):
            raise HTTPException(503, "Tiger write failed")
    return OkOut(detail="purged")


@router.post("/voice-outcome", response_model=OkOut)
async def voice_outcome(body: DemoVoiceOutcomeIn, p: DemoAdmin) -> OkOut:
    """Stub voice only: the operator's sticky outcome for this device's challenge responses (None clears).
    Every result it produces is published with simulated=true (§8 C2 stub honesty)."""
    if voice_demo.voice_mode() != "stub":
        raise HTTPException(409, "real voice mode: outcomes come from the voice pipeline, not the operator")
    drt = _drt(p, body.device_id)
    voice_demo.set_override(drt.device_id, body.decision)
    audit = rt().extras.get("audit")
    text = (f"Demo voice outcome set to {body.decision} (simulated)" if body.decision
            else "Demo voice outcome cleared (label-aware simulated default)")
    if audit is not None:
        audit.emit("admin_action", text, device_id=drt.device_id, user_id=drt.dev.user_id, severity=1,
                   actor=p.user.handle)
    rt().hub.feed(drt, "operator", text, 1)
    return OkOut(detail=text)


@router.post("/org/seed", response_model=OrgSeedOut)
async def org_seed(body: OrgSeedIn, p: DemoAdmin) -> OrgSeedOut:
    """Idempotent pseudonymous org-demo users emp01..empNN@org.2bme.tech, one monitor-mode device each.
    Re-seeding keeps users, devices, trust and models, and rotates every device token (returned once)."""
    r = rt()
    reg, hub = r.registry, r.hub
    out: list[OrgEmployee] = []
    for i in range(1, body.n + 1):
        email = f"emp{i:02d}{ORG_DOMAIN}"
        handle, team = f"Employee {i:02d}", ORG_TEAMS[(i - 1) % len(ORG_TEAMS)]
        user = reg.user_by_email(email)
        if user is None:
            user = reg.add_user(email, UNUSABLE_PW, handle, "user")
        if user.team != team or user.handle != handle:
            user.team, user.handle = team, handle
            reg.save_user(user)
        devs = sorted(reg.devices_of(user.id), key=lambda d: str(d.id))
        if devs:
            dev = devs[0]
            token = "dt_" + secrets.token_urlsafe(32)
            dev.token_hash = token_hash(token)
            reg.save_device(dev)
        else:
            label, os_, pointer = ORG_DEVICES[(i - 1) % len(ORG_DEVICES)]
            dev, token = reg.register_device(user.id, label, os_, pointer, None, mode="monitor")
        hub.rt(dev)
        out.append(OrgEmployee(user_id=user.id, handle=handle, team=team, device_id=dev.id, device_token=token))
    reg.save_mirror(force=True)
    audit = r.extras.get("audit")
    if audit is not None:
        audit.emit("admin_action", f"Org demo seeded: {body.n} synthetic employees (device tokens rotated)",
                   severity=0, actor=p.user.handle)
    return OrgSeedOut(employees=out)
