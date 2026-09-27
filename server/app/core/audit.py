"""Org audit trail and per-device org tracking for the admin panel (§2.4, newGoal).

`AuditLog.observe()` is hooked into `DeviceHub.publish()`: every live event the hub emits passes through it
once, so trust-LEVEL changes (not every tick), alerts (anomalies), challenge status changes, decisions, locks,
markers, operator resets and model versions become `AuditRow`s without touching the hub's tick path. Admin
actions call `emit()` directly.

Each row goes to an in-memory ring (the degraded-mode fallback), to Tiger `audit_log` (migration 006) through
the batch writer, and to `/ws/live` as type `audit` for admin subscribers (never to device owners).

`actor` is "system" unless the row was caused inside an admin/operator request, which sets `current_actor`
(a ContextVar) via `acting()` to `actor_name()`: the handle of a person with a cookie session, or, for an
`X-Admin-Token` caller (scripts, the e2e, the attack tool), "<X-Actor or 'automation'> (API token)" — never the
human admin that token resolves to.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from collections import deque
from collections.abc import Iterator
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from app.core.runtime import rt
from twobme_common.types import AnomalyLive, AuditRow, utcnow

log = logging.getLogger("twobme.audit")

RING_MAX = 4000
ORG_DOMAIN = "@org.2bme.tech"

current_actor: ContextVar[str | None] = ContextVar("twobme_audit_actor", default=None)


@contextlib.contextmanager
def acting(handle: str | None) -> Iterator[None]:
    """Attribute every audit row emitted inside this block to `handle` (an admin/operator)."""
    tok = current_actor.set(handle)
    try:
        yield
    finally:
        current_actor.reset(tok)


TOKEN_ACTOR_MAX = 40


def actor_name(handle: str, *, via_token: bool, x_actor: str | None = None) -> str:
    """Who an audit row names: a cookie session is that person; a token caller is automation, named by its
    optional X-Actor header and always marked as token-authenticated."""
    if not via_token:
        return handle
    name = " ".join("".join(ch for ch in (x_actor or "") if ch.isprintable()).split())[:TOKEN_ACTOR_MAX]
    return f"{name or 'automation'} (API token)"


def is_synthetic_email(email: str | None) -> bool:
    return bool(email) and email.lower().endswith(ORG_DOMAIN)


def model_backend(models: Any, user_id: UUID) -> str | None:
    """Which scorer serves this user: ModelInfo.backend when set, else the loaded scorer's family."""
    try:
        mi = models.model_info(user_id)
        if getattr(mi, "backend", None):
            return mi.backend
        sc = models.scorer(user_id)
        if sc is None:
            return None
        mod = type(sc).__module__ or ""
        return "twobme_ml" if mod.startswith("twobme_ml") else "fallback"
    except Exception:
        return None


@dataclass
class DevTrack:
    audited_level: str | None = None
    pending_level: str | None = None
    pending_n: int = 0
    last_anomaly: AnomalyLive | None = None
    last_anomaly_at: datetime | None = None
    last_remote_at: datetime | None = None
    last_redteam_audit: float = 0.0
    prelock_conf: float | None = None  # admin lock: behavioral confidence restored on admin unlock
    drift_on: bool = False             # insider drift currently raised (one alert per rising edge)
    drift_checked: float = 0.0         # monotonic time of the last insider-drift evaluation


# insider drift (roster flag + one org alert per episode): UEBA-style slow drift in the watch band
DRIFT_WINDOW_S = 300.0
DRIFT_MIN_POINTS = 24          # >= 2 min of 5 s ticks before the insider-drift flag can fire
DRIFT_BELOW = 0.80
DRIFT_FRACTION = 0.60
DRIFT_MAX_SUSPICIOUS = 0.10    # a window that was mostly < 0.40 is a (past) takeover, not a slow drift
DRIFT_CHECK_S = 10.0           # the audit hook re-evaluates it at most this often per device
DRIFT_SUMMARY = "Insider drift: most of the last 5 min below 80% with no takeover — review activity, don't block"


def drift_points(drt: Any) -> list[Any]:
    """This session's trust points of the last DRIFT_WINDOW_S, oldest first (learning/locked points excluded):
    /demo/reset starts a new session, so the flag clears with the loop reset."""
    now = utcnow()
    since = getattr(drt, "session_started_at", None)
    return [p for p in list(drt.history)
            if 0 <= (now - p.t).total_seconds() <= DRIFT_WINDOW_S and p.level not in ("learning", "locked")
            and (since is None or p.t >= since)]


def insider_drift(drt: Any, level: str, takeover: bool) -> bool:
    """Sustained sub-0.80 confidence (>= 60% of the last 5 min) on a device still labelled genuine with no
    takeover marker, that is not (and in this window was not) a takeover suspicion: UEBA-style slow drift in the
    watch band, not a sudden swap."""
    if takeover or drt.label != "genuine" or drt.in_takeover or level in ("learning", "locked"):
        return False
    pts = drift_points(drt)
    if len(pts) < DRIFT_MIN_POINTS:
        return False
    if sum(1 for p in pts if p.confidence < 0.40) / len(pts) > DRIFT_MAX_SUSPICIOUS:
        return False
    return sum(1 for p in pts if p.confidence < DRIFT_BELOW) / len(pts) >= DRIFT_FRACTION


LEVEL_SEVERITY = {"suspicious": 3, "watch": 2, "normal": 0, "learning": 0}
REASON_TEXT = {
    "operator_reset": "operator reset (not an authentication)", "operator_rearm": "operator re-arm",
    "voice_verify": "voice verified", "totp_verify": "TOTP verified", "model_activated": "model activated",
    "screen_unlock": "screen unlock", "admin_unlock": "admin unlock",
}
CHALLENGE_TEXT: dict[str, tuple[str, int]] = {
    "fallback_mfa": ("Voice gray zone — TOTP fallback ({trigger})", 2),
    "verified": ("Challenge verified ({trigger}){via}", 1),
    "blocked_spoof": ("Challenge BLOCKED — synthetic voice ({trigger}){via}", 5),
    "blocked_impostor": ("Challenge BLOCKED — different speaker ({trigger}){via}", 5),
    "expired": ("Challenge expired unanswered ({trigger})", 2),
    "cancelled": ("Challenge cancelled ({trigger})", 0),
}
ISSUED_TEXT = {
    "proactive": ("Proactive voice challenge armed", 3),
    "step_up": ("Step-up voice challenge issued", 2),
    "unlock": ("Unlock voice challenge issued", 1),
}
ALERT_TEXT = {
    "takeover_suspected": "Takeover suspected", "voice_spoof": "Synthetic voice blocked",
    "voice_impostor": "Different speaker blocked", "trust_drop": "Trust drop", "lock": "Device locked",
    "redteam_tool": "Red-team tool read the active challenge",
}
VOICE_KINDS = ("voice_spoof", "voice_impostor")
LOCK_TEXT = {"voice_spoof": "voice spoof", "voice_impostor": "voice impostor", "lock": "failed TOTP",
             "admin_lock": "admin lock"}
MARKER_TEXT = {
    "takeover_start": ("Marker: takeover started (impostor at keyboard)", 2),
    "takeover_end": ("Marker: takeover ended", 1),
    "rearm": ("Operator re-arm at {text}", 1),
    "note": ("Note: {text}", 0),
}


def _remember(d: dict, key: Any, value: Any, cap: int = 5000) -> None:
    d[key] = value
    if len(d) > cap:
        for k in list(d)[: len(d) - cap]:
            d.pop(k, None)


class AuditLog:
    def __init__(self, *, writer: Any, live: Any, registry: Any, repo_voice: Any = None, models: Any = None):
        self.writer = writer
        self.live = live
        self.registry = registry
        self.repo_voice = repo_voice
        self.models = models
        self.ring: deque[AuditRow] = deque(maxlen=RING_MAX)
        self.dev: dict[UUID, DevTrack] = {}
        self.forced_challenges: set[UUID] = set()  # admin force_reverify (not a detection)
        self.acked: set[UUID] = set()
        self._anoms: dict[UUID, UUID | None] = {}
        self._ch: dict[UUID, tuple[str, str]] = {}
        self._dec: dict[UUID, tuple[str, str]] = {}
        self._models: dict[tuple, bool] = {}
        self._markers: dict[tuple, bool] = {}
        self._handlers = {
            "trust": self._on_trust, "anomaly": self._on_anomaly, "challenge": self._on_challenge,
            "decision": self._on_decision, "lock": self._on_lock, "unlock": self._on_unlock,
            "marker": self._on_marker, "snapshot": self._on_snapshot, "model": self._on_model,
        }

    # --- emit / query ------------------------------------------------------------------------------
    def track(self, device_id: UUID) -> DevTrack:
        t = self.dev.get(device_id)
        if t is None:
            t = self.dev[device_id] = DevTrack()
        return t

    def emit(self, kind: str, summary: str, *, device_id: UUID | None = None, user_id: UUID | None = None,
             severity: int = 0, ref_id: UUID | None = None, actor: str | None = None) -> AuditRow:
        if user_id is None and device_id is not None:
            dev = self.registry.devices.get(device_id)
            user_id = dev.user_id if dev is not None else None
        u = self.registry.users.get(user_id) if user_id is not None else None
        row = AuditRow(id=uuid.uuid4(), t=utcnow(), kind=kind, device_id=device_id, user_id=user_id,
                       handle=u.handle if u is not None else None, actor=actor or current_actor.get() or "system",
                       summary=summary[:240], severity=max(0, min(5, int(severity))), ref_id=ref_id)
        self.ring.append(row)
        try:
            self.writer.insert("audit_log", {
                "time": row.t, "id": row.id, "kind": row.kind, "device_id": row.device_id, "user_id": row.user_id,
                "handle": row.handle, "actor": row.actor, "summary": row.summary, "severity": row.severity,
                "ref_id": row.ref_id,
            })
        except Exception:
            log.exception("audit row not queued for Tiger")
        # owner_id=None: only admin subscribers (org scope, or an admin pinned to this device) receive it
        self.live.publish(device_id, None, "audit", row)
        return row

    def recent(self, limit: int, device_id: UUID | None = None) -> list[AuditRow]:
        out: list[AuditRow] = []
        for row in reversed(self.ring):
            if device_id is None or row.device_id == device_id:
                out.append(row)
                if len(out) >= limit:
                    break
        return out

    def merge(self, tiger: list[AuditRow] | None, limit: int, device_id: UUID | None) -> list[AuditRow]:
        """Tiger rows plus ring rows the writer hasn't flushed yet; newest first, deduped by id."""
        ring = self.recent(limit, device_id)
        if tiger is None:
            return ring
        seen: dict[UUID, AuditRow] = {r.id: r for r in tiger}
        for r in ring:
            seen.setdefault(r.id, r)
        return sorted(seen.values(), key=lambda r: r.t, reverse=True)[:limit]

    # --- hub hook ------------------------------------------------------------------------------------
    def observe(self, drt: Any, type_: str, data: Any) -> None:
        """Called from DeviceHub.publish for every live event. Cheap, and never raises into the hub."""
        h = self._handlers.get(type_)
        if h is None or drt is None or data is None:
            return
        try:
            h(drt, data)
        except Exception:
            log.exception("audit observe failed (%s)", type_)

    def _emit_dev(self, drt: Any, kind: str, summary: str, severity: int = 0, ref_id: UUID | None = None) -> None:
        self.emit(kind, summary, device_id=drt.dev.id, user_id=drt.dev.user_id, severity=severity, ref_id=ref_id)

    def _on_trust(self, drt: Any, tl: Any) -> None:
        level = getattr(tl, "level", None)
        if level is None:
            return
        t = self.track(drt.dev.id)
        self._check_drift(drt, t, level)
        prev = t.audited_level
        if prev is None or level == prev:
            t.audited_level, t.pending_level, t.pending_n = level, None, 0
            return
        if level == "locked" or prev == "locked":  # lock / unlock rows cover these transitions
            t.audited_level, t.pending_level, t.pending_n = level, None, 0
            return
        if level != t.pending_level:
            t.pending_level, t.pending_n = level, 0
        t.pending_n += 1
        # operator/anchor pushes (seq None) and suspicious in/out are immediate; everything else must hold for 2
        # events, so a device hovering at 0.80 doesn't flood the trail and the transient band published by a
        # learning -> monitor switch (right before the model-activation anchor) is never logged
        immediate = (getattr(tl, "seq", None) is None or prev == "suspicious"
                     or (level == "suspicious" and prev != "learning"))
        if not (immediate or t.pending_n >= 2):
            return
        t.audited_level, t.pending_level, t.pending_n = level, None, 0
        why = [REASON_TEXT[r] for r in (getattr(tl, "reasons", None) or []) if r in REASON_TEXT]
        disp = getattr(tl, "display", None)
        summary = f"Trust {prev} → {level}" + (f" ({disp}%)" if disp is not None else "")
        if why:
            summary += " · " + why[0]
        self._emit_dev(drt, "trust_change", summary, LEVEL_SEVERITY.get(level, 0))

    def _check_drift(self, drt: Any, t: DevTrack, level: str) -> None:
        """Insider drift raises one alert per episode: evaluated at most every DRIFT_CHECK_S per device; on the
        rising edge an anomaly goes through the hub (Tiger row, live event, explainer), so the roster's last alert
        can be acknowledged; the falling edge (e.g. the new session a /demo/reset starts) re-arms it."""
        now = time.monotonic()
        if now - t.drift_checked < DRIFT_CHECK_S:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # a sync caller: nothing to schedule on, try again on the next trust event
            return
        t.drift_checked = now
        try:
            on = insider_drift(drt, level, level == "suspicious" or drt.in_takeover)
        except Exception:  # never costs the trust-change row below
            log.exception("insider-drift check failed")
            return
        if on and not t.drift_on:
            loop.call_soon(self._raise_drift, drt)  # never re-enter hub.publish from inside its hook
        t.drift_on = on

    def _raise_drift(self, drt: Any) -> None:
        try:
            first = min(drift_points(drt), key=lambda p: p.t, default=None)  # the confidence ~5 min ago
            rt().hub.anomaly(drt, "trust_drop", 3, before=first.confidence if first is not None else None,
                             after=drt.engine.confidence, top=drt.last_top, action="insider_drift")
        except Exception:
            log.exception("insider-drift alert not raised")

    def _on_anomaly(self, drt: Any, a: Any) -> None:
        t = self.track(drt.dev.id)
        if a.id in self._anoms:  # an explanation update for an anomaly we already logged
            if t.last_anomaly is not None and t.last_anomaly.id == a.id:
                t.last_anomaly = a
            return
        _remember(self._anoms, a.id, drt.dev.id)
        if a.kind == "redteam_tool":
            # the attack tool long-polls: at most one row a minute, and never the roster's "last alert"
            now = time.monotonic()
            if now - t.last_redteam_audit < 60:
                return
            t.last_redteam_audit = now
        else:
            t.last_anomaly, t.last_anomaly_at = a, utcnow()
        if a.action == "insider_drift":
            self._emit_dev(drt, "alert", DRIFT_SUMMARY, 3, a.id)
            return
        summary = ALERT_TEXT.get(a.kind, a.kind.replace("_", " ").capitalize())
        top = a.top_features[0] if a.top_features else None
        if a.kind in VOICE_KINDS:  # a voice verdict, not a behavioral deviation: say whether the voice was simulated
            from app.core.voice_demo import voice_mode

            if voice_mode() == "stub":
                summary += " · simulated voice"
        elif top is not None:  # a never-seen category can score |z| in the thousands: say "far outside" instead
            summary += f" — {top.label} " + (f"{top.z:+.1f}σ" if abs(top.z) <= 99
                                              else "far outside baseline (|z| > 99)")
        self._emit_dev(drt, "alert", summary, a.severity, a.id)

    def _on_challenge(self, drt: Any, cl: Any) -> None:
        trigger, status = cl.trigger, cl.status
        if trigger in ("redteam", "sandbox"):
            return
        if status == "issued":
            text, sev = ISSUED_TEXT.get(trigger, (f"Voice challenge issued ({trigger})", 1))
            if cl.challenge_id in self.forced_challenges:
                text = "Voice re-verify requested by admin"
        elif status in CHALLENGE_TEXT:
            text, sev = CHALLENGE_TEXT[status]
        else:
            return
        key = (status, trigger)
        if self._ch.get(cl.challenge_id) == key:
            return
        _remember(self._ch, cl.challenge_id, key)
        via = ""
        if status in ("verified", "blocked_spoof", "blocked_impostor"):
            row = self.repo_voice.challenges.get(cl.challenge_id) if self.repo_voice is not None else None
            if row is not None and row.get("decision") == "TOTP":
                via = " · TOTP"
            else:
                from app.core.voice_demo import voice_mode

                via = " · simulated voice" if voice_mode() == "stub" else " · voice"
        self._emit_dev(drt, "challenge", text.format(trigger=trigger.replace("_", "-"), via=via), sev,
                       cl.challenge_id)

    def _on_decision(self, drt: Any, d: Any) -> None:
        key = (d.status, d.trans_status)
        prior = self._dec.get(d.decision_id)
        if prior == key:
            return
        _remember(self._dec, d.decision_id, key)
        amt = f" ${d.amount_cents / 100:,.0f}" if d.amount_cents else ""
        if prior is None:
            if d.binding == "remote":
                self.track(drt.dev.id).last_remote_at = utcnow()
            summary = (f"Decision: {d.action}{amt} → {d.trans_status} ({d.decision.replace('_', '-')}, {d.tier}, "
                       f"conf {d.confidence:.2f}, {d.binding})")
        else:
            reason = d.reasons[-1] if d.reasons else d.decision
            summary = f"Decision resolved: {d.action}{amt} → {d.trans_status} ({reason})"
        self._emit_dev(drt, "decision", summary, {"Y": 0, "C": 2, "N": 4}.get(d.trans_status, 1), d.decision_id)

    def _on_lock(self, drt: Any, lk: Any) -> None:
        reason = getattr(lk, "reason", None) or "locked"
        self._emit_dev(drt, "lock", f"Device LOCKED ({LOCK_TEXT.get(reason, reason)})", 5)

    def _on_unlock(self, drt: Any, _data: Any) -> None:
        self._emit_dev(drt, "lock", "Device unlocked", 1)

    def _on_marker(self, drt: Any, mp: Any) -> None:
        key = (drt.dev.id, mp.t, mp.label)
        if key in self._markers or mp.label not in MARKER_TEXT:
            return
        _remember(self._markers, key, True)
        text, sev = MARKER_TEXT[mp.label]
        self._emit_dev(drt, "marker", text.format(text=mp.text or ""), sev)

    def _on_snapshot(self, drt: Any, snap: Any) -> None:
        # the hub publishes a snapshot only from /demo/reset; its newest marker is the reset marker
        markers = getattr(snap, "markers", None) or []
        if not markers or markers[-1].label != "reset":
            return
        mp = markers[-1]
        key = (drt.dev.id, mp.t, "reset")
        if key in self._markers:
            return
        _remember(self._markers, key, True)
        self._emit_dev(drt, "marker", "Operator reset — not an authentication", 1)

    def _on_model(self, drt: Any, info: Any) -> None:
        uid = drt.dev.user_id
        bound = self.registry.bound_device(uid)  # a model is per user: one row, on the user's current device
        if bound is not None and bound.id != drt.dev.id:
            return
        if info.status == "ready" and info.version and not info.error:
            key = (uid, "ready", info.version)
            if key in self._models:
                return
            _remember(self._models, key, True)
            be = getattr(info, "backend", None) or (model_backend(self.models, uid) if self.models else None)
            n = sum((info.n_blocks or {}).values())
            self._emit_dev(drt, "model", f"Identity model v{info.version} active"
                           + (f" ({be})" if be else "") + (f" · {n} blocks" if n else ""), 1)
        elif info.error and info.status != "training":
            key = (uid, "failed", info.job_id)
            if key in self._models:
                return
            _remember(self._models, key, True)
            self._emit_dev(drt, "model", f"Training failed: {str(info.error)[:120]}", 3)
