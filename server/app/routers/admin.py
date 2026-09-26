"""Admin / org panel API (§2.4, contracts/api.md "Admin / org panel"): admin cookie or X-Admin-Token.

- GET  /admin/roster   every device's live hub state as RosterRow (real devices first, then by severity)
- GET  /admin/audit    the org audit trail (Tiger `audit_log` when up, merged with the in-memory ring)
- POST /admin/actions  lock | unlock | force_reverify | ack_alert | note — each one audited with the admin's handle

Behavior alone never blocks: an admin lock is an explicit human action, recorded as such. Unlock clears only an
admin lock; voice/BLOCK locks still need a VERIFY (§5.4).
"""

from __future__ import annotations

import time
from datetime import timedelta
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException

from app.auth import AdminPrincipal
from app.core.audit import AuditLog, acting, is_synthetic_email, model_backend
from app.core.hub import DeviceRuntime
from app.core.runtime import rt
from app.db import history as H
from twobme_common.types import (
    AdminActionIn,
    AgentChallenge,
    AgentLock,
    AgentUnlock,
    AuditRow,
    ChallengeLive,
    LockLive,
    RosterRow,
    utcnow,
)

router = APIRouter(prefix="/admin", tags=["admin"])

ONLINE_S = 30.0
DRIFT_WINDOW_S = 300.0
DRIFT_MIN_POINTS = 24          # >= 2 min of 5 s ticks before the insider-drift flag can fire
DRIFT_BELOW = 0.80
DRIFT_FRACTION = 0.60
REMOTE_WINDOW = timedelta(minutes=10)
SPARK_N = 60
LEVEL_RANK = {"locked": 0, "suspicious": 1, "watch": 2, "normal": 3, "learning": 4}


def audit_log() -> AuditLog:
    a = rt().extras.get("audit")
    if a is None:
        raise HTTPException(503, "audit log not initialised")
    return a


def _drt(device_id: UUID) -> DeviceRuntime:
    r = rt()
    dev = r.registry.devices.get(device_id)
    if dev is None:
        raise HTTPException(404, "unknown device")
    return r.hub.rt(dev)


# --- roster ---------------------------------------------------------------------------------------------
def insider_drift(drt: DeviceRuntime, level: str, takeover: bool) -> bool:
    """Sustained sub-0.80 confidence (>= 60% of the last 5 min) on a device still labelled genuine with no
    takeover marker, that is not (yet) a takeover suspicion: UEBA-style slow drift, not a sudden swap."""
    if takeover or drt.label != "genuine" or drt.in_takeover or level in ("learning", "locked"):
        return False
    now = utcnow()
    pts = [p for p in list(drt.history)
           if 0 <= (now - p.t).total_seconds() <= DRIFT_WINDOW_S and p.level not in ("learning", "locked")]
    if len(pts) < DRIFT_MIN_POINTS:
        return False
    return sum(1 for p in pts if p.confidence < DRIFT_BELOW) / len(pts) >= DRIFT_FRACTION


def roster_row(drt: DeviceRuntime) -> RosterRow:
    r = rt()
    hub, dev = r.hub, drt.dev
    user = r.registry.users.get(dev.user_id)
    audit = r.extras.get("audit")
    tr = audit.track(dev.id) if audit is not None else None
    tl = drt.trust or hub._trust_live(drt, drt.engine.snapshot_state(time.time()), None)
    level = "locked" if dev.locked else tl.level
    open_rows = r.repo_voice.open_for_device(dev.id)
    oc = None
    if open_rows:
        o = open_rows[0]
        oc = ChallengeLive(challenge_id=o["id"], trigger=o["trigger"], status=o["status"], attempt=o["attempt"],
                           expires_at=o.get("expires_at"), verify_url=r.settings.verify_url(o["id"]))
    forced = audit.forced_challenges if audit is not None else set()
    takeover = level == "suspicious" or (oc is not None and oc.trigger == "proactive"
                                         and oc.challenge_id not in forced)
    flags: list[str] = []
    if takeover:
        flags.append("takeover_suspected")
    if insider_drift(drt, level, takeover):
        flags.append("insider_drift")
    if tr is not None and tr.last_remote_at is not None and utcnow() - tr.last_remote_at <= REMOTE_WINDOW:
        flags.append("remote_session")
    if dev.locked and dev.lock_reason == "admin_lock":
        flags.append("admin_locked")
    if oc is not None:
        flags.append("challenge_open")
    mi = r.models.model_info(dev.user_id)
    age = drt.heartbeat_age()
    return RosterRow(
        device_id=dev.id, user_id=dev.user_id, handle=user.handle if user else "unknown",
        team=getattr(user, "team", None), synthetic=is_synthetic_email(user.email if user else None),
        device_label=dev.label, online=age is not None and age < ONLINE_S, last_seen=dev.last_seen, mode=dev.mode,
        level=level, confidence=round(tl.confidence, 4), display=tl.display, locked=dev.locked,
        lock_reason=dev.lock_reason, open_challenge=oc,
        model_version=mi.version if mi.status == "ready" or (mi.version and mi.status == "training") else None,
        model_backend=model_backend(r.models, dev.user_id),
        last_anomaly=tr.last_anomaly if tr else None, last_anomaly_at=tr.last_anomaly_at if tr else None,
        sparkline=[round(p.confidence, 4) for p in list(drt.history)[-SPARK_N:]], flags=flags,
    )


def build_roster() -> list[RosterRow]:
    r = rt()
    rows = [roster_row(r.hub.rt(dev)) for dev in list(r.registry.devices.values())]
    rows.sort(key=lambda x: (x.synthetic, not x.online, LEVEL_RANK.get(x.level, 5), x.handle, x.device_label))
    return rows


@router.get("/roster", response_model=list[RosterRow])
async def roster(p: AdminPrincipal) -> list[RosterRow]:
    return build_roster()


# --- audit ----------------------------------------------------------------------------------------------
@router.get("/audit", response_model=list[AuditRow])
async def audit(p: AdminPrincipal, limit: int = 100, device_id: UUID | None = None) -> list[AuditRow]:
    limit = max(1, min(limit, 1000))
    a = audit_log()
    tiger = await H.audit(rt().db, limit, device_id)
    return a.merge(tiger, limit, device_id)


# --- actions --------------------------------------------------------------------------------------------
async def admin_lock(drt: DeviceRuntime, by: str) -> None:
    r = rt()
    hub, dev = r.hub, drt.dev
    if dev.locked:
        raise HTTPException(409, f"device already locked ({dev.lock_reason})")
    audit_log().track(dev.id).prelock_conf = drt.engine.confidence
    dev.locked, dev.locked_at, dev.lock_reason = True, utcnow(), "admin_lock"
    r.registry.save_device(dev)
    drt.engine.pin_min()  # §5.4 while locked: L pinned to its minimum
    tl = hub._push_trust(drt, ["admin_lock"])
    await hub.send_agent(drt, AgentLock(reason="admin_lock"))
    await hub._agent_trust(drt, tl)
    hub.publish(drt, "lock", LockLive(reason="admin_lock"))
    hub.feed(drt, "lock", f"Device LOCKED by admin {by}", 5)


async def admin_unlock(drt: DeviceRuntime, by: str) -> None:
    r = rt()
    hub, dev = r.hub, drt.dev
    if not dev.locked:
        raise HTTPException(409, "device is not locked")
    if dev.lock_reason != "admin_lock":
        raise HTTPException(409, "voice unlock required")
    tr = audit_log().track(dev.id)
    # the admin lock was a precaution, not evidence: restore the behavioral confidence it pinned (never higher;
    # the remote prior when unknown, e.g. after a restart)
    restore = tr.prelock_conf if tr.prelock_conf is not None else hub.cfg.anchors.remote
    tr.prelock_conf = None
    dev.locked, dev.locked_at, dev.lock_reason = False, None, None
    r.registry.save_device(dev)
    drt.below = 0
    drt.engine.anchor(restore)
    await hub.send_agent(drt, AgentUnlock())
    hub.publish(drt, "unlock", {})
    tl = hub._push_trust(drt, ["admin_unlock"])
    await hub._agent_trust(drt, tl)
    hub.feed(drt, "lock", f"Admin lock cleared by {by}", 1)


async def force_reverify(drt: DeviceRuntime, by: str) -> UUID:
    r = rt()
    hub = r.hub
    if drt.dev.locked:
        raise HTTPException(409, "device is locked; unlock first")
    if r.repo_voice.open_for_device(drt.device_id):
        raise HTTPException(409, "a challenge is already open for this device")
    ch = await r.issuer.issue(device_id=drt.device_id, subject_user_id=drt.dev.user_id, session_id=drt.session_id,
                              trigger="proactive", decision_id=None)
    audit_log().forced_challenges.add(ch.challenge_id)
    drt.rearm_ok, drt.armed_at = False, time.monotonic()  # the arming state machine treats it as armed
    await hub.send_agent(drt, AgentChallenge(challenge_id=ch.challenge_id, trigger="proactive",
                                             verify_url=ch.verify_url, expires_at=ch.expires_at,
                                             open_browser=not r.live.browser_recent(drt.device_id)))
    hub.publish(drt, "challenge", hub._challenge_live(ch))
    hub.feed(drt, "challenge", f"Admin {by} requested a voice re-verify", 3)
    return ch.challenge_id


async def ack_alert(drt: DeviceRuntime, anomaly_id: UUID | None) -> tuple[str, UUID]:
    if anomaly_id is None:
        raise HTTPException(422, "anomaly_id is required for ack_alert")
    r = rt()
    a = audit_log()
    owner = a._anoms.get(anomaly_id)
    if owner is not None and owner != drt.device_id:
        raise HTTPException(422, "that alert belongs to another device")
    a.acked.add(anomaly_id)
    r.writer.execute("UPDATE anomalies SET resolution = 'acknowledged' WHERE id = $1", anomaly_id)
    tr = a.track(drt.device_id)
    kind = tr.last_anomaly.kind if tr.last_anomaly is not None and tr.last_anomaly.id == anomaly_id else "alert"
    return kind.replace("_", " "), anomaly_id


@router.post("/actions", response_model=AuditRow)
async def actions(body: AdminActionIn, p: AdminPrincipal) -> AuditRow:
    drt = _drt(body.device_id)
    by = p.user.handle
    a = audit_log()
    ref: Any = None
    with acting(by):
        if body.action == "lock":
            await admin_lock(drt, by)
            summary, sev = "Admin lock", 5
        elif body.action == "unlock":
            await admin_unlock(drt, by)
            summary, sev = "Admin lock cleared", 2
        elif body.action == "force_reverify":
            ref = await force_reverify(drt, by)
            summary, sev = "Forced voice re-verify", 3
        elif body.action == "ack_alert":
            kind, ref = await ack_alert(drt, body.anomaly_id)
            summary, sev = f"Alert acknowledged ({kind})", 1
        else:  # note: audit-only
            text = (body.text or "").strip()
            if not text:
                raise HTTPException(422, "text is required for a note")
            summary, sev = f"Note: {text[:80]}", 0
        return a.emit("admin_action", summary, device_id=drt.device_id, user_id=drt.dev.user_id, severity=sev,
                      ref_id=ref, actor=by)
