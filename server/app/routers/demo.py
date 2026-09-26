"""Demo / admin endpoints (§5.3, §13 expo mode). Require DEMO_MODE=1."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException

from app.auth import DemoAdmin, DemoPrincipal, Principal
from app.core.hub import DeviceRuntime
from app.core.runtime import rt
from twobme_common.types import (
    DemoDeviceIn,
    DemoLabelIn,
    DemoMarkerIn,
    DemoRearmIn,
    MarkerPoint,
    OkOut,
    PurgeSessionIn,
    RedteamActiveOut,
    Snapshot,
    TrustLive,
)

router = APIRouter(prefix="/demo", tags=["demo"])


def _drt(p: Principal, device_id: UUID) -> DeviceRuntime:
    r = rt()
    dev = r.registry.devices.get(device_id)
    if dev is None or not (p.is_admin or dev.user_id == p.user.id):
        raise HTTPException(404, "unknown device")
    return r.hub.rt(dev)


@router.post("/label", response_model=OkOut)
async def label(body: DemoLabelIn, p: DemoPrincipal) -> OkOut:
    await rt().hub.set_label(_drt(p, body.device_id), body.label, body.actor)
    return OkOut()


@router.post("/marker", response_model=MarkerPoint)
async def marker(body: DemoMarkerIn, p: DemoPrincipal) -> MarkerPoint:
    return await rt().hub.add_marker(_drt(p, body.device_id), body.label, None, body.text, source="dashboard")


@router.post("/reset", response_model=Snapshot)
async def reset(body: DemoDeviceIn, p: DemoAdmin) -> Snapshot:
    return await rt().hub.reset(_drt(p, body.device_id), by=f"dashboard:{p.user.handle}")


@router.post("/rearm", response_model=TrustLive)
async def rearm(body: DemoRearmIn, p: DemoAdmin) -> TrustLive:
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
