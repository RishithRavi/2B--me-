"""DeviceHub (§6 A1): the hot path. In-memory per device; Tiger only receives queued rows.

tick → dedupe (device, run_id, seq) → score blocks (+ temporal context) → TrustEngine.on_tick →
level / lock / proactive-challenge state machine (§5.4) → push `trust` to agent + `/ws/live` →
queue rows (stamped with the device's current label/actor) → persist trust_state.

Invariants (tested in server/tests):
- behavior alone never blocks; `block` only when the device is locked;
- markers never reach the scorer or TrustEngine (they only change label/actor stamping);
- L = logit(0.97) only via voice VERIFY / TOTP pass, /demo/reset, or model activation (label ≠ impostor);
- a web login, WS reconnect or `hello` never raises L;
- lock only via BLOCK_* on proactive/step_up, or a failed TOTP after FALLBACK_MFA; unlock only via
  VERIFY/TOTP on an unlock challenge, or /demo/reset.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from fastapi import WebSocket
from pydantic import BaseModel

from app.core import policy as policy_mod
from app.core.presence import PresenceTracker
from app.core.registry import Device
from app.core.trust_fallback import TrustEngine as FallbackEngine
from app.core.trust_fallback import load_trust_engine_cls
from twobme_common.config import TrustConfig, logit, sigmoid
from twobme_common.spec import MODALITIES, load_spec
from twobme_common.types import (
    AgentChallenge,
    AgentError,
    AgentLock,
    AgentModalityTrust,
    AgentMode,
    AgentTrust,
    AgentUnlock,
    AnomalyLive,
    Block,
    BlockScore,
    BlockScored,
    ChallengeLive,
    ChallengeOut,
    ContextLive,
    DecisionDetailOut,
    DecisionLive,
    DecisionOut,
    DeviationOut,
    EnrollProgress,
    FeedItem,
    HealthLive,
    Hello,
    LabelLive,
    LiveDevice,
    LockLive,
    MarkerPoint,
    ModeLive,
    ModelInfo,
    PresenceLive,
    ResolvedDecision,
    Snapshot,
    Tick,
    TrustLive,
    TrustPoint,
    TrustState,
    VoiceOutcome,
    VoiceResult,
    VoiceResultLive,
    Welcome,
    utcnow,
)

log = logging.getLogger("twobme.hub")

HISTORY_S = 600
REVOKE_UPDATE_S = 120      # update_candidate revoked for blocks this long before arming / BLOCK_* (§5.3)
FACTOR_REENROLL_S = 300    # replacing a factor needs a voice/TOTP VERIFY on the bound device this recently
MARKER_TEXT_MAX = 80       # marker text is truncated server-side (§2.2)
# server-side feed lines for challenge status changes (armed/verified/blocked are fed elsewhere)
CHALLENGE_FEED = {
    "prompt_ended": ("Voice prompt played ({trigger}) — recording reply", 1),
    "retry": ("Voice check retry — attempt {attempt}, fresh phrase", 2),
    "fallback_mfa": ("Voice gray zone — TOTP fallback (90 s)", 2),
    "expired": ("Voice challenge expired ({trigger})", 2),
    "cancelled": ("Voice challenge cancelled ({trigger})", 1),
}
TERMINAL = {"verified", "blocked_spoof", "blocked_impostor", "expired", "cancelled"}
ADMIN_LOCK = "admin_lock"  # lock_reason of an /admin/actions lock (only an admin unlock or /demo/reset clears it)


# ------------------------------------------------------------------------------------------------
# Engine adapter: works with twobme_ml.trust.TrustEngine or the fallback, and tracks the state.
# ------------------------------------------------------------------------------------------------
class EngineAdapter:
    def __init__(self, cfg: TrustConfig, engine: Any, kind: str):
        self.cfg = cfg
        self.engine = engine
        self.kind = kind
        self._calc = FallbackEngine(cfg)  # formula helper for per-block display values
        self.state: TrustState | None = None
        self.L: float = logit(0.97)
        self.last_t: float | None = _engine_t(engine)

    @classmethod
    def new(cls, cfg: TrustConfig, p0: float) -> EngineAdapter:
        ecls, kind = load_trust_engine_cls()
        eng = _construct(ecls, cfg)
        a = cls(cfg, eng, kind)
        a.anchor(p0)
        return a

    @classmethod
    def restore(cls, cfg: TrustConfig, d: dict[str, Any]) -> EngineAdapter:
        ecls, kind = load_trust_engine_cls()
        saved_kind = d.get("kind")
        data = d.get("engine") or {}
        try:
            if saved_kind == kind and hasattr(ecls, "from_dict"):
                eng = ecls.from_dict(data) if kind != "fallback" else FallbackEngine.from_dict(data, cfg)
            else:
                raise ValueError("engine kind changed")
        except Exception:
            eng = _construct(ecls, cfg)
            with contextlib.suppress(Exception):
                eng.anchor(sigmoid(float(d.get("L", logit(0.30)))))
        a = cls(cfg, eng, kind)
        a.L = float(d.get("L", logit(0.30)))
        return a

    def to_dict(self) -> dict[str, Any]:
        try:
            eng = self.engine.to_dict()
        except Exception:
            eng = {}
        return {"kind": self.kind, "engine": eng, "L": self.L}

    @property
    def confidence(self) -> float:
        return sigmoid(self.L)

    def in_order(self, t_end: float) -> bool:
        """False for a tick at or before the engine's last tick (it must not be scored)."""
        return self.last_t is None or t_end > self.last_t

    def on_tick(self, t_end: float, idle_s: float, scores: list[BlockScore]) -> TrustState:
        """Never raises: an engine error degrades to "no evidence this tick" (then to "no change")."""
        try:
            st = self.engine.on_tick(t_end, idle_s, scores)
        except Exception as e:
            log.warning("trust engine rejected a tick (%s: %s); applying it without evidence",
                        type(e).__name__, str(e)[:120])
            try:
                st = self.engine.on_tick(t_end, max(0.0, idle_s), [])
            except Exception as e2:
                log.warning("trust engine rejected an empty tick (%s); trust unchanged", type(e2).__name__)
                st = self.snapshot_state(t_end, ["engine_error"])
        self.state = st
        self.L = st.logit
        self.last_t = t_end if self.last_t is None else max(self.last_t, t_end)
        return st

    def anchor(self, p: float) -> None:
        self.engine.anchor(p)
        c = self.cfg.logit_cap
        self.L = max(-c, min(c, logit(p)))
        self.state = None

    def pin_min(self) -> None:
        self.anchor(1 - self.cfg.cap)

    def snapshot_state(self, t: float, reasons: list[str] | None = None) -> TrustState:
        conf = sigmoid(self.L)
        per = self.state.per_modality if self.state else {}
        return TrustState(t=t, logit=self.L, delta_logit=0.0, confidence=conf, display=min(99, round(100 * conf)),
                          level=self._calc.band(conf), per_modality=per, reasons=reasons or [])

    def block_contrib(self, s: BlockScore) -> tuple[float, float, float]:
        """(llr, q, delta) for one block, per the §5.4 formulas (display/rows only)."""
        llr = self._calc.llr(s)
        q = min(1.0, s.n / self.cfg.n_ref[s.modality])
        d = self.cfg.kappa * self.cfg.weights.get(s.modality, 0.0) * q * self._calc.f(llr)
        return llr, q, d


def _engine_t(engine: Any) -> float | None:
    """The engine's last tick time (twobme_ml: `t`, fallback: `t_prev`), if it tracks one."""
    for attr in ("t", "t_prev"):
        v = getattr(engine, attr, None)
        if isinstance(v, int | float) and math.isfinite(v):
            return float(v)
    return None


def _usable_score(s: BlockScore) -> bool:
    """Drop scores the engine would reject (non-finite / out-of-range typicality or LLR)."""
    if s.n <= 0:
        return False
    if s.typicality is not None and not (math.isfinite(s.typicality) and 0.0 <= s.typicality <= 1.0):
        return False
    return s.llr_direct is None or math.isfinite(s.llr_direct)


def _app_categories() -> frozenset[str]:
    """On-device app categories (contracts/app_categories.json, §2.2)."""
    try:
        import json

        from twobme_common.paths import contracts_dir

        cats = json.loads((contracts_dir() / "app_categories.json").read_text())["categories"]
        return frozenset(str(c) for c in cats)
    except Exception as e:
        log.warning("app_categories.json unreadable (%s); using the built-in category list", e)
        return frozenset({"browser", "ide", "terminal", "chat", "docs", "media", "system", "other"})


def _construct(ecls: type, cfg: TrustConfig) -> Any:
    for args in ((cfg,), ()):
        try:
            return ecls(*args)
        except TypeError:
            continue
    return ecls()


# ------------------------------------------------------------------------------------------------
# Per-device runtime state
# ------------------------------------------------------------------------------------------------
@dataclass
class DecisionRec:
    id: UUID
    time: datetime
    user_id: UUID
    device_id: UUID | None
    session_id: UUID | None
    web_session_id: str | None
    action: str
    amount_cents: int | None
    tier: str
    binding: str
    confidence: float
    decision: str
    trans_status: str
    status: str
    challenge_id: UUID | None
    reasons: list[str]
    label: str
    actor: str
    verify_url: str | None = None
    final_decision: str | None = None
    final_trans_status: str | None = None
    resolved_at: datetime | None = None
    mfa_deadline: float | None = None

    def out(self) -> DecisionOut:
        return DecisionOut(decision_id=self.id, status=self.status, decision=self.decision,
                           trans_status=self.trans_status, confidence=self.confidence, tier=self.tier,
                           binding=self.binding, reasons=self.reasons, challenge_id=self.challenge_id,
                           verify_url=self.verify_url)

    def detail(self) -> DecisionDetailOut:
        return DecisionDetailOut(**self.out().model_dump(), action=self.action, amount_cents=self.amount_cents,
                                 final_decision=self.final_decision, final_trans_status=self.final_trans_status,
                                 resolved_at=self.resolved_at)

    def live(self) -> DecisionLive:
        return DecisionLive(**self.out().model_dump(), action=self.action, amount_cents=self.amount_cents)


@dataclass
class DeviceRuntime:
    dev: Device
    engine: EngineAdapter
    label: str = "genuine"
    actor: str = "a"
    session_id: UUID | None = None
    session_kind: str = "normal"
    session_started_at: datetime | None = None
    run_id: UUID | None = None
    agent_ws: WebSocket | None = None
    agent_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    agent_disconnected_at: float | None = None
    seen: dict[UUID, deque] = field(default_factory=dict)
    trust: TrustLive | None = None
    last_seq: int | None = None
    history: deque = field(default_factory=lambda: deque(maxlen=400))     # TrustPoint
    markers: deque = field(default_factory=lambda: deque(maxlen=100))     # MarkerPoint
    feed: deque = field(default_factory=lambda: deque(maxlen=50))         # FeedItem (newest last)
    last_tick_json: dict | None = None
    last_block_at: dict[str, datetime] = field(default_factory=dict)
    activity: dict[int, int] = field(default_factory=dict)
    tap_rate: float | None = None
    rtt_ms: float | None = None
    secure_input: bool = False
    idle_s: float = 0.0
    below: int = 0
    rearm_ok: bool = True
    armed_at: float | None = None
    arming: bool = False
    in_takeover: bool = False
    failed_challenge: bool = False
    last_verify_at: datetime | None = None
    last_block_event_at: datetime | None = None
    lock_seen_run: UUID | None = None
    tick_count: int = 0
    tick_cond: asyncio.Condition = field(default_factory=asyncio.Condition)
    enroll_counts: dict[str, int] = field(default_factory=lambda: {m: 0 for m in MODALITIES})
    enroll_loaded: bool = False
    last_top: list[DeviationOut] = field(default_factory=list)
    recent_blocks: deque = field(default_factory=lambda: deque(maxlen=200))  # BlockScored
    totp_failures: dict[UUID, int] = field(default_factory=dict)

    @property
    def device_id(self) -> UUID:
        return self.dev.id

    def is_dup(self, run_id: UUID, seq: int) -> bool:
        d = self.seen.setdefault(run_id, deque(maxlen=4096))
        if seq in d:
            return True
        d.append(seq)
        if len(self.seen) > 16:
            for k in list(self.seen)[:-16]:
                self.seen.pop(k, None)
        return False

    def heartbeat_age(self) -> float | None:
        if self.dev.last_seen is None:
            return None
        return max(0.0, (utcnow() - self.dev.last_seen).total_seconds())


class HubError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


# ------------------------------------------------------------------------------------------------
# The hub
# ------------------------------------------------------------------------------------------------
class DeviceHub:
    def __init__(self, *, settings: Any, cfg: TrustConfig, registry: Any, writer: Any, live: Any, models: Any,
                 repo_voice: Any, issuer_getter: Any, explainer: Any = None):
        self.s = settings
        self.cfg = cfg
        self.spec = load_spec()
        self.registry = registry
        self.writer = writer
        self.live = live
        self.models = models
        self.repo_voice = repo_voice
        self._issuer_getter = issuer_getter
        self.explainer = explainer
        self.devices: dict[UUID, DeviceRuntime] = {}
        self.decisions: dict[UUID, DecisionRec] = {}
        self.presence: dict[str, PresenceTracker] = {}
        self._loop_task: asyncio.Task | None = None
        self._last_health: float = 0.0
        self.app_categories = _app_categories()
        self.privacy_drops = 0  # transition keys dropped by the §2.2 server-side check (count only)
        self.models.on_activated = self._on_model_activated
        self.models.on_status = self._on_model_status

    @property
    def issuer(self) -> Any:
        return self._issuer_getter()

    # --- lifecycle ---------------------------------------------------------------------------
    def restore(self) -> None:
        """Restore every device's TrustEngine from devices.trust_state (§5.4)."""
        now = utcnow()
        for dev in self.registry.devices.values():
            self._restore_one(dev, now)

    def _restore_one(self, dev: Device, now: datetime) -> DeviceRuntime:
        st = dev.trust_state or {}
        if st.get("engine") is not None or "L" in st:
            eng = EngineAdapter.restore(self.cfg, st)
            t = st.get("t")
            stale = True
            if t:
                with contextlib.suppress(Exception):
                    stale = (now - datetime.fromisoformat(t)).total_seconds() > self.cfg.restart_stale_s
            if stale:
                eng.anchor(self.cfg.anchors.restart_stale)
        else:
            p0 = self.cfg.anchors.new_device_enroll if dev.mode == "enroll" else self.cfg.anchors.new_device_monitor
            eng = EngineAdapter.new(self.cfg, p0)
        drt = DeviceRuntime(dev=dev, engine=eng, label=st.get("label", "genuine"), actor=st.get("actor", "a"))
        drt.in_takeover = bool(st.get("in_takeover", False))
        drt.lock_seen_run = UUID(st["lock_seen_run"]) if st.get("lock_seen_run") else None
        if st.get("session_id"):
            drt.session_id = UUID(st["session_id"])
        self.devices[dev.id] = drt
        return drt

    def rt(self, dev: Device) -> DeviceRuntime:
        drt = self.devices.get(dev.id)
        if drt is None:
            drt = self._restore_one(dev, utcnow())
        return drt

    def rt_by_id(self, device_id: UUID | None) -> DeviceRuntime | None:
        if device_id is None:
            return None
        drt = self.devices.get(device_id)
        if drt is None:
            dev = self.registry.devices.get(device_id)
            if dev is not None:
                drt = self._restore_one(dev, utcnow())
        return drt

    def start(self) -> None:
        self._loop_task = asyncio.create_task(self._loop(), name="hub-loop")

    async def stop(self) -> None:
        if self._loop_task:
            self._loop_task.cancel()
        for drt in self.devices.values():
            self._persist(drt)
        self.registry.save_mirror(force=True)

    # --- helpers ----------------------------------------------------------------------------------
    def publish(self, drt: DeviceRuntime | None, type_: str, data: BaseModel | dict | None) -> None:
        audit = getattr(self, "audit", None)  # core.audit.AuditLog (org audit trail, §2.4); set in main
        if audit is not None:
            audit.observe(drt, type_, data)
        if drt is None:
            self.live.publish(None, None, type_, data)
        else:
            self.live.publish(drt.device_id, drt.dev.user_id, type_, data)

    def feed(self, drt: DeviceRuntime, type_: str, text: str, severity: int = 0) -> None:
        item = FeedItem(t=utcnow(), type=type_, text=text, severity=severity)
        drt.feed.append(item)
        self.publish(drt, "feed", item)

    async def send_agent(self, drt: DeviceRuntime, msg: BaseModel) -> None:
        ws = drt.agent_ws
        if ws is None:
            return
        try:
            async with drt.agent_lock:
                await ws.send_text(msg.model_dump_json())
        except Exception as e:
            log.info("agent send failed (%s): %s", drt.device_id, e)

    def learning(self, drt: DeviceRuntime) -> bool:
        return drt.dev.mode == "enroll" or self.models.scorer(drt.dev.user_id) is None

    def level_for(self, drt: DeviceRuntime, band: str) -> str:
        if drt.dev.locked:
            return "locked"
        if self.learning(drt):
            return "learning"
        return band

    def _trust_live(self, drt: DeviceRuntime, st: TrustState, seq: int | None) -> TrustLive:
        return TrustLive(**{**st.model_dump(), "level": self.level_for(drt, st.level)}, seq=seq,
                         locked=drt.dev.locked)

    def _persist(self, drt: DeviceRuntime) -> None:
        drt.dev.trust_state = {
            **drt.engine.to_dict(), "t": utcnow().isoformat(), "label": drt.label, "actor": drt.actor,
            "in_takeover": drt.in_takeover, "session_id": str(drt.session_id) if drt.session_id else None,
            "lock_seen_run": str(drt.lock_seen_run) if drt.lock_seen_run else None,
        }
        self.registry.save_device(drt.dev)

    def _push_trust(self, drt: DeviceRuntime, reasons: list[str], seq: int | None = None) -> TrustLive:
        st = drt.engine.snapshot_state(time.time(), reasons)
        tl = self._trust_live(drt, st, seq)
        drt.trust = tl
        drt.history.append(TrustPoint(t=utcnow(), confidence=tl.confidence, level=tl.level))
        self.publish(drt, "trust", tl)
        self._persist(drt)
        return tl

    async def _agent_trust(self, drt: DeviceRuntime, tl: TrustLive) -> None:
        await self.send_agent(drt, AgentTrust(
            seq=tl.seq, confidence=tl.confidence, display=tl.display, level=tl.level, locked=drt.dev.locked,
            per_modality={m: AgentModalityTrust(llr=c.llr, delta=c.delta) for m, c in tl.per_modality.items()},
        ))

    # --- sessions ---------------------------------------------------------------------------------
    def _new_session(self, drt: DeviceRuntime, run_id: UUID | None, kind: str = "normal") -> UUID:
        sid = uuid.uuid4()
        drt.session_id = sid
        drt.session_kind = kind
        drt.session_started_at = utcnow()
        self.writer.insert("sessions", {
            "id": sid, "user_id": drt.dev.user_id, "device_id": drt.device_id, "channel": "desktop", "kind": kind,
            "status": "active", "started_at": drt.session_started_at, "run_id": run_id,
        })
        return sid

    def _end_session(self, drt: DeviceRuntime, reason: str) -> None:
        if drt.session_id is None:
            return
        self.writer.execute(
            "UPDATE sessions SET status='ended', ended_at=now(), ended_reason=$2 WHERE id=$1 AND status='active'",
            drt.session_id, reason,
        )
        drt.session_id = None

    def _welcome(self, drt: DeviceRuntime) -> Welcome:
        mi = self.models.model_info(drt.dev.user_id)
        return Welcome(device_id=drt.device_id, user_id=drt.dev.user_id, session_id=drt.session_id,
                       mode=drt.dev.mode, model_version=mi.version if mi.status == "ready" else None,
                       label=drt.label, actor=drt.actor)

    # --- agent connection -----------------------------------------------------------------------
    async def agent_hello(self, dev: Device, hello: Hello, ws: WebSocket) -> DeviceRuntime:
        drt = self.rt(dev)
        old = drt.agent_ws
        drt.agent_ws = ws
        drt.agent_disconnected_at = None
        if old is not None and old is not ws:
            with contextlib.suppress(Exception):
                await old.close(code=4409, reason="superseded")
        dev.pointer, dev.os = hello.pointer, hello.os
        dev.display = hello.display.model_dump()
        prev_seen = dev.last_seen
        dev.last_seen = utcnow()
        if hello.requested_mode and hello.requested_mode != dev.mode:
            if hello.requested_mode == "enroll" and self.models.scorer(dev.user_id) is not None:
                # §5.3: once a user has an active model, only an admin may put a device back in enroll mode
                self.feed(drt, "mode", "Agent asked for enroll mode — ignored (identity model active; admin only)", 2)
            else:
                await self.set_mode(drt, hello.requested_mode, source="agent hello")
        resume_ok = (
            hello.resume_session_id is not None and hello.resume_session_id == drt.session_id and prev_seen is not None
            and (utcnow() - prev_seen).total_seconds() < self.cfg.session.resume_max_s
        )
        if not resume_ok:
            if drt.session_id is not None:
                self._end_session(drt, "ws_timeout")
            self._new_session(drt, hello.run_id)
        if drt.run_id != hello.run_id:
            drt.run_id = hello.run_id
        await self._ensure_enroll_counts(drt)
        # NOTE: reconnecting never changes L; the idle hazard over the gap applies at the next tick.
        await self.send_agent(drt, self._welcome(drt))
        if drt.trust is not None:
            await self._agent_trust(drt, drt.trust)
        if drt.dev.locked:
            await self.send_agent(drt, AgentLock(reason=drt.dev.lock_reason or "locked"))
        self.feed(drt, "agent", f"Agent connected ({hello.agent_version}, {hello.pointer})")
        self._persist(drt)
        return drt

    def agent_disconnected(self, drt: DeviceRuntime, ws: WebSocket) -> None:
        if drt.agent_ws is ws:
            drt.agent_ws = None
            drt.agent_disconnected_at = time.monotonic()
            self.feed(drt, "agent", "Agent disconnected")

    async def agent_message(self, drt: DeviceRuntime, msg: BaseModel) -> None:
        from twobme_common import types as T

        drt.dev.last_seen = utcnow()
        if isinstance(msg, T.Tick):
            await self.ingest_tick(drt, msg)
        elif isinstance(msg, T.MarkerMsg):
            await self.add_marker(drt, msg.label, msg.t, msg.text, source="hotkey")
        elif isinstance(msg, T.OsEventMsg):
            await self.os_event(drt, msg.event, msg.t)
        elif isinstance(msg, T.DemoMsg):
            if self.s.demo_mode:
                await self.reset(drt, by="hotkey")
            else:
                await self.send_agent(drt, AgentError(code="demo_off", detail="DEMO_MODE is off"))
        elif isinstance(msg, T.ClockPing):
            from twobme_common.types import ClockPong

            await self.send_agent(drt, ClockPong(t0_ns=msg.t0_ns, server_ns=time.time_ns()))
        elif isinstance(msg, T.Hello):
            await self.send_agent(drt, AgentError(code="duplicate_hello"))

    # --- ticks ------------------------------------------------------------------------------------
    async def ingest_tick(self, drt: DeviceRuntime, tick: Tick) -> str:
        """Never raises. Every tick the hub accepts is acked to the agent (`trust` with its seq) — scored,
        late, out-of-order, duplicate or failed — so the agent's outbox always drains."""
        if drt.is_dup(tick.run_id, tick.seq):
            await self._ack_unscored(drt, tick)
            return "duplicate"
        try:
            return await self._ingest_tick(drt, tick)
        except Exception:
            log.exception("tick ingest failed (device %s, seq %s); acked without evidence", drt.device_id, tick.seq)
            await self._ack_unscored(drt, tick)
            return "error"

    async def _ack_unscored(self, drt: DeviceRuntime, tick: Tick) -> None:
        """Ack a tick that was not scored with the current trust. The agent acks by (its current run_id,
        seq), so a tick of another run (HTTPS fallback of an old run) is never acked over the WS."""
        if drt.agent_ws is None or tick.run_id != drt.run_id:
            return
        tl = drt.trust or self._trust_live(drt, drt.engine.snapshot_state(time.time()), None)
        await self._agent_trust(drt, tl.model_copy(update={"seq": tick.seq}))

    def _clean_transitions(self, b: Block) -> Block:
        """§2.2 defense in depth: workflow `transitions` keys must be "from>to" pairs of the categories in
        contracts/app_categories.json. Anything else (a bundle id, a title) is dropped and only counted."""
        if not b.transitions:
            return b
        cats = self.app_categories
        ok: dict[str, int] = {}
        for k, v in b.transitions.items():
            a, sep, c = k.partition(">")
            if sep and a in cats and c in cats and isinstance(v, int) and 0 <= v <= 100_000:
                ok[k] = v
        dropped = len(b.transitions) - len(ok)
        if not dropped:
            return b
        self.privacy_drops += dropped
        log.warning("dropped %d workflow transition key(s) that are not category pairs (total %d)",
                    dropped, self.privacy_drops)
        return b.model_copy(update={"transitions": ok or None})

    async def _valid_blocks(self, drt: DeviceRuntime, tick: Tick) -> list[tuple[Block, bool]]:
        """Blocks (+ temporal context) that match the spec exactly (privacy + contract), transitions cleaned."""
        blocks: list[tuple[Block, bool]] = [(b, False) for b in tick.blocks]
        if tick.context is not None:
            blocks.append((tick.context, True))
        valid: list[tuple[Block, bool]] = []
        for b, is_ctx in blocks:
            try:
                self.spec.check_features(b.modality, b.features)
            except ValueError as e:
                await self.send_agent(drt, AgentError(code="bad_block", detail=str(e)[:300]))
                continue
            valid.append((self._clean_transitions(b), is_ctx))
        return valid

    @staticmethod
    def _tick_json(tick: Tick, valid: list[tuple[Block, bool]]) -> dict:
        """The literal payload for "What left this laptop", rebuilt from validated blocks only."""
        d = tick.model_dump(mode="json")
        d["blocks"] = [b.model_dump(mode="json") for b, is_ctx in valid if not is_ctx]
        ctx = next((b for b, is_ctx in valid if is_ctx), None)
        d["context"] = ctx.model_dump(mode="json") if ctx is not None else None
        return d

    async def _ingest_tick(self, drt: DeviceRuntime, tick: Tick) -> str:
        now = utcnow()
        drt.dev.last_seen = now
        flags = tick.flags.model_copy()
        t_end = tick.t_end
        late = flags.late or (tick.session_id is not None and drt.session_id is not None
                              and tick.session_id != drt.session_id)
        if not late and abs((t_end - now).total_seconds()) >= self.cfg.hub.clock_skew_s:
            t_end = now
            flags.clock_skew = True
        # at or before the engine's last tick: stored like a late tick, never scored (the engine refuses it)
        out_of_order = not late and not drt.engine.in_order(t_end.timestamp())
        if drt.session_id is None and not late:
            self._new_session(drt, tick.run_id)
        session_id = tick.session_id if late and tick.session_id else drt.session_id

        # validate blocks against the spec (exact feature names = privacy + contract)
        valid = await self._valid_blocks(drt, tick)

        if not late:  # fresh input (out-of-order included): co-presence activity + health, never scoring
            base = int(t_end.timestamp()) - len(tick.activity)
            for i, n in enumerate(tick.activity):
                drt.activity[base + i + 1] = int(n)
            cutoff = int(t_end.timestamp()) - 120
            for k in [k for k in drt.activity if k < cutoff]:
                del drt.activity[k]
            c = tick.counts
            drt.tap_rate = (c.keys + c.mouse_moves + c.clicks + c.scroll_events) / 5.0
            drt.secure_input = flags.secure_input
            drt.idle_s = flags.idle_s
            if flags.rtt_ms is not None:
                drt.rtt_ms = flags.rtt_ms
            drt.last_tick_json = self._tick_json(tick, valid)

        scorer = self.models.scorer(drt.dev.user_id)
        learning = self.learning(drt)
        model_version = getattr(scorer, "version", None) if scorer is not None else None
        stale_cut = now - timedelta(seconds=self.cfg.hub.late_drop_s)
        scored: list[tuple[Block, bool, BlockScore | None]] = []
        for b, is_ctx in valid:
            s = None
            if (scorer is not None and drt.dev.mode == "monitor" and b.t_end >= stale_cut and not late
                    and not out_of_order):
                try:
                    s = await asyncio.to_thread(scorer.score_block, b)
                except Exception as e:  # a scorer error = no evidence from this block
                    log.warning("score_block failed (%s): %s", b.modality, type(e).__name__)
                if s is not None and not _usable_score(s):
                    log.warning("score_block returned an unusable score (%s); ignored", b.modality)
                    s = None
            scored.append((b, is_ctx, s))

        if late or out_of_order:
            self._queue_block_rows(drt, scored, session_id, model_version, flags, {}, late=True)
            await self._ack_unscored(drt, tick)
            return "late"

        prev_conf = drt.engine.confidence
        prev_level = drt.trust.level if drt.trust else None
        evidence = [s for _, _, s in scored if s is not None] if not learning and not drt.dev.locked else []
        st = drt.engine.on_tick(t_end.timestamp(), flags.idle_s, evidence)
        if drt.dev.locked:
            drt.engine.pin_min()
            per = st.per_modality
            st = drt.engine.snapshot_state(t_end.timestamp(), ["device_locked"])
            st.per_modality = per
        tl = self._trust_live(drt, st, tick.seq)
        drt.trust = tl
        drt.last_seq = tick.seq
        drt.history.append(TrustPoint(t=t_end, confidence=tl.confidence, level=tl.level))
        while drt.history and (t_end - drt.history[0].t).total_seconds() > HISTORY_S:
            drt.history.popleft()

        # update_candidate stamping (§7 B7)
        contrib: dict[int, tuple[float, float, float]] = {}
        cand: dict[int, bool] = {}
        for i, (b, is_ctx, s) in enumerate(scored):
            if s is not None:
                contrib[i] = drt.engine.block_contrib(s)
            cand[i] = self._update_candidate(drt, b, contrib.get(i), learning)
        self._queue_block_rows(drt, scored, session_id, model_version, flags, contrib, cand=cand)

        # arming state machine (§5.4) — behavior alone never blocks
        armed_now = self._arming_step(drt, tl.confidence, learning)
        if armed_now:
            self._revoke_update_candidates(drt, t_end, "proactive arming")

        # trust_ticks row
        mod_llr = {m: c.llr for m, c in st.per_modality.items()}
        self.writer.insert("trust_ticks", {
            "time": t_end, "device_id": drt.device_id, "session_id": session_id, "user_id": drt.dev.user_id,
            "run_id": tick.run_id, "seq": tick.seq, "confidence": tl.confidence, "display": tl.display,
            "logit": tl.logit, "delta_logit": tl.delta_logit, "level": tl.level,
            "kb_llr": mod_llr.get("keyboard"), "ms_llr": mod_llr.get("mouse"), "sc_llr": mod_llr.get("scroll"),
            "wf_llr": mod_llr.get("workflow"), "tp_llr": mod_llr.get("temporal"), "challenge_issued": armed_now,
            "model_version": model_version, "label": drt.label, "actor": drt.actor,
            "flags": {**flags.model_dump(), "counts": tick.counts.model_dump()},
        })

        # broadcasts
        self.publish(drt, "trust", tl)
        await self._agent_trust(drt, tl if tick.run_id == drt.run_id else tl.model_copy(update={"seq": None}))
        top_all: list[DeviationOut] = []
        for i, (b, is_ctx, s) in enumerate(scored):
            drt.last_block_at[b.modality] = b.t_end
            llr, q, d = contrib.get(i, (None, None, None))
            top = [DeviationOut(feature=dv.feature, label=self.spec.label(dv.feature), unit=self.spec.unit(dv.feature),
                                z=dv.z) for dv in (s.top if s else []) if dv.feature in self.spec._idx]
            top_all.extend(top)
            bs = BlockScored(modality=b.modality, t_start=b.t_start, t_end=b.t_end, n=b.n,
                             typicality=s.typicality if s else None, llr=llr, q=q, delta=d, top=top)
            drt.recent_blocks.append(bs)
            self.publish(drt, "block_scored", bs)
            if is_ctx:
                self.publish(drt, "context", ContextLive(psd=b.psd, features=b.features,
                                                         enrolled_psd=self.models.enrolled_psd.get(drt.dev.user_id)))
        drt.last_top = sorted(top_all, key=lambda x: -abs(x.z))[:5]
        if drt.dev.mode == "enroll":
            self.publish(drt, "enroll_progress", self.enroll_progress(drt))
        self._maybe_health(drt, force=True)

        if prev_level != "suspicious" and tl.level == "suspicious":
            self.feed(drt, "trust", f"Trust fell to {tl.display}% — suspicious", 3)
            self.anomaly(drt, "trust_drop", 3, prev_conf, tl.confidence, drt.last_top, action="watch")
        elif prev_level and prev_level != tl.level and tl.level in ("normal", "watch"):
            self.feed(drt, "trust", f"Trust {tl.display}% — {tl.level}")

        self._persist(drt)
        async with drt.tick_cond:
            drt.tick_count += 1
            drt.tick_cond.notify_all()
        return "ok"

    def _update_candidate(self, drt: DeviceRuntime, b: Block, contrib: tuple[float, float, float] | None,
                          learning: bool) -> bool:
        if learning or drt.label == "impostor" or drt.session_kind != "normal":
            return False
        uc = self.cfg.update_candidate
        if drt.last_verify_at is not None and 0 <= (b.t_end - drt.last_verify_at).total_seconds() <= uc.post_verify_s:
            return True
        if drt.in_takeover or drt.failed_challenge or drt.dev.locked or contrib is None:
            return False
        if self.repo_voice.open_for_device(drt.device_id):
            return False
        if contrib[0] < uc.min_llr:
            return False
        window = [p for p in drt.history if 0 < (b.t_end - p.t).total_seconds() <= uc.window_s]
        return len(window) >= 6 and min(p.confidence for p in window) >= uc.min_conf

    def _revoke_update_candidates(self, drt: DeviceRuntime, t_ref: datetime, why: str) -> None:
        """§5.3: blocks in the REVOKE_S before a proactive arming or a BLOCK_* never feed the safe update loop
        (the impostor may have been at the keyboard before trust fell)."""
        self.writer.execute(
            "UPDATE feature_blocks SET update_candidate = false "
            "WHERE device_id = $1 AND time >= $2 AND update_candidate",
            drt.device_id, t_ref - timedelta(seconds=REVOKE_UPDATE_S),
        )
        log.info("update candidates revoked for %s (%s)", drt.device_id, why)

    def _queue_block_rows(self, drt: DeviceRuntime, scored: list, session_id: UUID | None, model_version: Any,
                          flags: Any, contrib: dict, cand: dict | None = None, late: bool = False) -> None:
        if session_id is None:
            return
        for i, (b, is_ctx, s) in enumerate(scored):
            llr, q, d = contrib.get(i, (None, None, None))
            extras: dict[str, Any] = {}
            if b.transitions:
                extras["transitions"] = b.transitions
            if b.psd:
                extras["psd"] = b.psd
            if is_ctx:
                extras["context"] = True
            eligible = drt.dev.mode == "enroll" and drt.label != "impostor" and drt.session_kind == "normal"
            row = {
                "time": b.t_end, "block_start": b.t_start, "user_id": drt.dev.user_id, "device_id": drt.device_id,
                "session_id": session_id, "channel": "desktop", "modality": b.modality,
                "schema_version": self.spec.schema_version, "mode": drt.dev.mode, "n": b.n,
                "features": self.spec.vectorize(b.modality, b.features),
                **{c: None for _, c in self.spec.headline_columns()},
                **self.spec.headline_values(b.modality, b.features),
                "extras": extras or None, "typicality": s.typicality if s else None, "llr": llr, "q": q, "delta": d,
                "model_version": model_version, "label": drt.label, "actor": drt.actor,
                "baseline_eligible": eligible, "update_candidate": bool(cand.get(i)) if cand else False,
                "flags": {"late": late, "clock_skew": flags.clock_skew, "secure_input": flags.secure_input,
                          "injected": flags.injected},
            }
            self.writer.insert("feature_blocks", row)
            if eligible and not late:
                if b.modality == "temporal":
                    drt.enroll_counts["_temporal_raw"] = drt.enroll_counts.get("_temporal_raw", 0) + 1
                    drt.enroll_counts["temporal"] = drt.enroll_counts["_temporal_raw"] // 6
                else:
                    drt.enroll_counts[b.modality] = drt.enroll_counts.get(b.modality, 0) + 1

    # --- arming -----------------------------------------------------------------------------------
    def _arming_step(self, drt: DeviceRuntime, conf: float, learning: bool) -> bool:
        a = self.cfg.arming
        if learning or drt.dev.locked:
            drt.below = 0
            return False
        drt.below = drt.below + 1 if conf < a.threshold else 0
        has_open = bool(self.repo_voice.open_for_device(drt.device_id))
        if not drt.rearm_ok and not has_open:
            if conf > a.rearm_above or (drt.armed_at is not None and time.monotonic() - drt.armed_at >= a.cooldown_s):
                drt.rearm_ok = True
        if drt.below >= a.consecutive_ticks and drt.rearm_ok and not has_open and not drt.arming:
            drt.rearm_ok = False
            drt.armed_at = time.monotonic()
            drt.arming = True
            asyncio.create_task(self._arm(drt, conf))
            return True
        return False

    async def _arm(self, drt: DeviceRuntime, conf: float) -> None:
        try:
            ch = await self.issuer.issue(device_id=drt.device_id, subject_user_id=drt.dev.user_id,
                                         session_id=drt.session_id, trigger="proactive", decision_id=None)
            open_browser = not self.live.browser_recent(drt.device_id)
            await self.send_agent(drt, AgentChallenge(challenge_id=ch.challenge_id, trigger="proactive",
                                                      verify_url=ch.verify_url, expires_at=ch.expires_at,
                                                      open_browser=open_browser))
            self.publish(drt, "challenge", self._challenge_live(ch))
            self.feed(drt, "challenge", f"Proactive voice check armed at {round(conf * 100)}%", 4)
            self.anomaly(drt, "takeover_suspected", 4, None, conf, drt.last_top, action="challenge_armed",
                         challenge_id=ch.challenge_id)
        except Exception:
            log.exception("arming failed")
            drt.rearm_ok = True
        finally:
            drt.arming = False

    @staticmethod
    def _challenge_live(ch: ChallengeOut) -> ChallengeLive:
        return ChallengeLive(challenge_id=ch.challenge_id, trigger=ch.trigger, status=ch.status, attempt=ch.attempt,
                             expires_at=ch.expires_at, verify_url=ch.verify_url)

    # --- anomalies ----------------------------------------------------------------------------------
    def anomaly(self, drt: DeviceRuntime | None, kind: str, severity: int, before: float | None,
                after: float | None, top: list[DeviationOut] | None = None, action: str | None = None,
                challenge_id: UUID | None = None, resolution: str | None = None) -> AnomalyLive:
        a = AnomalyLive(id=uuid.uuid4(), kind=kind, severity=severity, trust_before=before, trust_after=after,
                        top_features=list(top or [])[:5], action=action, challenge_id=challenge_id, explanation=None)
        t = utcnow()
        self.writer.insert("anomalies", {
            "time": t, "id": a.id, "user_id": drt.dev.user_id if drt else None,
            "device_id": drt.device_id if drt else None, "session_id": drt.session_id if drt else None,
            "kind": kind, "severity": severity, "trust_before": before, "trust_after": after,
            "top_features": [d.model_dump() for d in a.top_features], "action": action,
            "challenge_id": challenge_id, "explanation": None, "resolution": resolution,
        })
        self.publish(drt, "anomaly", a)
        if drt is not None:
            why = f" — {a.top_features[0].label} {a.top_features[0].z:+.1f}σ" if a.top_features else ""
            self.feed(drt, "anomaly", f"Anomaly: {kind.replace('_', ' ')} (severity {severity}){why}", min(severity, 5))
        if self.explainer is not None:
            asyncio.create_task(self._explain(drt, a, t))
        return a

    async def _explain(self, drt: DeviceRuntime | None, a: AnomalyLive, t: datetime) -> None:
        try:
            text = await self.explainer.explain(a)
        except Exception as e:
            log.info("explain failed: %s", e)
            return
        if not text:
            return
        a2 = a.model_copy(update={"explanation": text})
        self.writer.execute("UPDATE anomalies SET explanation=$3 WHERE id=$1 AND time=$2", a.id, t, text)
        self.publish(drt, "anomaly", a2)

    # --- markers, labels, os events ---------------------------------------------------------------
    async def add_marker(self, drt: DeviceRuntime, label: str, t: datetime | None, text: str | None,
                         source: str) -> MarkerPoint:
        t = t or utcnow()
        text = text[:MARKER_TEXT_MAX] if text else text  # §2.2: capped server-side, whatever the source
        mp = MarkerPoint(t=t, label=label, text=text)
        drt.markers.append(mp)
        self.writer.insert("markers", {"time": t, "device_id": drt.device_id, "session_id": drt.session_id,
                                       "label": label, "text": text})
        self.publish(drt, "marker", mp)
        # Markers are ground truth for the stopwatch/eval only — they only change label stamping.
        if label == "takeover_start":
            drt.in_takeover = True
            await self.set_label(drt, "impostor", "b", announce=False)
            self.feed(drt, "marker", f"Takeover started ({source}) — impostor at keyboard", 2)
        elif label == "takeover_end":
            await self.set_label(drt, "genuine", "a", announce=False)
            self.feed(drt, "marker", f"Takeover ended ({source})", 1)
        elif label == "note":
            # agent (hotkey) marker text is never echoed; operator notes typed on the dashboard are
            self.feed(drt, "marker", f"Note: {text or ''}" if source != "hotkey" else "Note (hotkey)")
        self._persist(drt)
        return mp

    async def set_label(self, drt: DeviceRuntime, label: str, actor: str, announce: bool = True) -> None:
        drt.label, drt.actor = label, actor
        self.publish(drt, "label", LabelLive(label=label, actor=actor))
        if announce:
            self.feed(drt, "label", f"Label set to {label}/{actor}")
        self._persist(drt)

    async def os_event(self, drt: DeviceRuntime, event: str, t: datetime) -> None:
        if event == "screen_locked":
            drt.lock_seen_run = drt.run_id
            self._end_session(drt, "screen_locked")
            self.feed(drt, "os", "Screen locked — session ended")
        elif event == "screen_unlocked":
            if drt.lock_seen_run is not None and drt.lock_seen_run == drt.run_id and not drt.dev.locked:
                # 0.80 is below the 0.90 R3 threshold: a purchase still needs ~5 genuine blocks.
                drt.engine.anchor(self.cfg.anchors.screen_unlock)
                tl = self._push_trust(drt, ["screen_unlock"])
                await self._agent_trust(drt, tl)
            drt.lock_seen_run = None
            if drt.session_id is None:
                self._new_session(drt, drt.run_id)
                await self.send_agent(drt, self._welcome(drt))
            self.feed(drt, "os", "Screen unlocked")
        else:
            self.feed(drt, "os", f"OS event: {event}")
        self._persist(drt)

    async def set_mode(self, drt: DeviceRuntime, mode: str, source: str = "api") -> None:
        if drt.dev.mode == mode:
            return
        drt.dev.mode = mode
        self.registry.save_device(drt.dev)
        self.publish(drt, "mode", ModeLive(mode=mode))
        await self.send_agent(drt, AgentMode(mode=mode))
        self.feed(drt, "mode", f"Mode → {mode} ({source})")
        await self._ensure_enroll_counts(drt)
        if drt.trust is not None:
            drt.trust = self._trust_live(drt, drt.engine.snapshot_state(time.time()), drt.last_seq)
            self.publish(drt, "trust", drt.trust)

    # --- demo controls -------------------------------------------------------------------------------
    async def reset(self, drt: DeviceRuntime, by: str) -> Snapshot:
        """/demo/reset: operator action, not an authentication (§5.3)."""
        for row in self.repo_voice.open_for_device(drt.device_id):
            with contextlib.suppress(Exception):
                await self.issuer.cancel(row["id"], "demo_reset")
            self._resolve_attached(row["id"], "block", "demo_reset")
        was_locked = drt.dev.locked
        drt.dev.locked, drt.dev.locked_at, drt.dev.lock_reason = False, None, None
        self._end_session(drt, "demo_reset")
        self._new_session(drt, drt.run_id)
        drt.label, drt.actor = "genuine", "a"
        drt.in_takeover = drt.failed_challenge = False
        drt.below, drt.rearm_ok, drt.armed_at = 0, True, None
        drt.totp_failures.clear()
        drt.engine.anchor(self.cfg.anchors.reset)
        mp = MarkerPoint(t=utcnow(), label="reset", text=by)
        drt.markers.append(mp)
        self.writer.insert("markers", {"time": mp.t, "device_id": drt.device_id, "session_id": drt.session_id,
                                       "label": "reset", "text": by})
        tl = self._push_trust(drt, ["operator_reset"])
        self.feed(drt, "operator", "Operator reset — not an authentication", 1)
        if was_locked:
            await self.send_agent(drt, AgentUnlock())
        await self.send_agent(drt, self._welcome(drt))
        await self._agent_trust(drt, tl)
        snap = self.snapshot(drt)
        self.publish(drt, "snapshot", snap)
        return snap

    async def rearm(self, drt: DeviceRuntime, confidence: float) -> TrustLive:
        for row in self.repo_voice.open_for_device(drt.device_id):
            with contextlib.suppress(Exception):
                await self.issuer.cancel(row["id"], "rearm")
            self._resolve_attached(row["id"], "block", "rearm")
        drt.engine.anchor(confidence)
        drt.below, drt.rearm_ok, drt.armed_at = 0, True, None
        await self.add_marker(drt, "rearm", utcnow(), f"{confidence:.2f}", source="operator")
        tl = self._push_trust(drt, ["operator_rearm"])
        await self._agent_trust(drt, tl)
        self.feed(drt, "operator", f"Re-armed at {round(confidence * 100)}%", 1)
        return tl

    # --- models -----------------------------------------------------------------------------------------
    async def _on_model_activated(self, user_id: UUID, info: ModelInfo) -> None:
        for drt in [d for d in self.devices.values() if d.dev.user_id == user_id]:
            # §5.4: activation anchors 0.97 only on a device that was enrolling; a device already in monitor
            # (e.g. a new device of an enrolled user, at 0.30) needs a strong factor instead
            was_enrolling = drt.dev.mode == "enroll"
            await self.set_mode(drt, "monitor", source=f"model v{info.version}")
            if was_enrolling and drt.label != "impostor" and not drt.dev.locked:
                drt.engine.anchor(self.cfg.anchors.model_activate)
                tl = self._push_trust(drt, ["model_activated"])
                await self._agent_trust(drt, tl)
            self.publish(drt, "model", info)
            self.feed(drt, "model", f"Identity model v{info.version} active", 1)
            if drt.agent_ws is not None and drt.session_id is not None:
                await self.send_agent(drt, self._welcome(drt))
        if not any(d.dev.user_id == user_id for d in self.devices.values()):
            self.live.publish(None, user_id, "model", info)

    async def _on_model_status(self, user_id: UUID, info: ModelInfo) -> None:
        for drt in [d for d in self.devices.values() if d.dev.user_id == user_id]:
            self.publish(drt, "model", info)
            if info.status == "ready" and info.error:
                self.feed(drt, "model", f"Retrain refused — v{info.version} kept: {info.error}", 2)
            elif info.status == "failed" or info.error:
                self.feed(drt, "model", f"Training failed: {info.error}", 3)
            elif info.status == "training":
                self.feed(drt, "model", "Training identity model…")

    def recent_strong_verify(self, user_id: UUID, within_s: float = FACTOR_REENROLL_S) -> bool:
        """A voice VERIFY or TOTP pass on the user's bound device within `within_s` (§5.3 factor rule)."""
        dev = self.registry.bound_device(user_id)
        drt = self.rt(dev) if dev is not None else None
        if drt is None or drt.last_verify_at is None:
            return False
        return 0 <= (utcnow() - drt.last_verify_at).total_seconds() <= within_s

    def any_open_challenge(self, user_id: UUID) -> bool:
        return any(self.repo_voice.open_for_device(d.device_id) for d in self.devices.values()
                   if d.dev.user_id == user_id)

    # --- enroll -------------------------------------------------------------------------------------------
    async def _ensure_enroll_counts(self, drt: DeviceRuntime) -> None:
        if drt.enroll_loaded:
            return
        rows = await self.registry_db_counts(drt.dev.user_id)
        if rows is not None:
            raw_t = rows.get("temporal", 0)
            drt.enroll_counts = {m: rows.get(m, 0) for m in MODALITIES}
            drt.enroll_counts["_temporal_raw"] = raw_t
            drt.enroll_counts["temporal"] = raw_t // 6
            drt.enroll_loaded = True

    async def registry_db_counts(self, user_id: UUID) -> dict[str, int] | None:
        db = getattr(self.writer, "db", None)
        if db is None:
            return None
        rows = await db.fetch(
            "SELECT modality, count(*) AS n FROM feature_blocks WHERE user_id=$1 AND baseline_eligible "
            "AND schema_version=$2 GROUP BY modality", user_id, self.spec.schema_version)
        if rows is None:
            return None
        return {r["modality"]: int(r["n"]) for r in rows}

    def enroll_progress(self, drt: DeviceRuntime) -> EnrollProgress:
        gates = {m: self.spec.modalities[m].enroll_gate for m in MODALITIES}
        counts = {m: int(drt.enroll_counts.get(m, 0)) for m in MODALITIES}
        ready = counts["keyboard"] >= gates["keyboard"] and counts["mouse"] >= gates["mouse"]
        return EnrollProgress(mode=drt.dev.mode, counts=counts, gates=gates, ready=ready)

    # --- presence / binding ---------------------------------------------------------------------------
    def presence_update(self, sid: str, user_id: UUID, buckets: list[tuple[int, int]],
                        client_now_ms: int | None) -> tuple[str, float | None, DeviceRuntime | None]:
        tr = self.presence.get(sid)
        if tr is None:
            tr = self.presence[sid] = PresenceTracker(self.cfg.binding)
        tr.add(buckets, client_now_ms)
        dev = self.registry.bound_device(user_id)
        drt = self.rt(dev) if dev else None
        if drt is not None:
            tr.update(drt.activity)
        binding, score = self.binding_for(sid, drt)
        if drt is not None:
            self.publish(drt, "presence", PresenceLive(binding=binding, score=score))
        return binding, score, drt

    def binding_for(self, sid: str | None, drt: DeviceRuntime | None) -> tuple[str, float | None]:
        if drt is None or sid is None:
            return "remote", None
        age = drt.heartbeat_age()
        if age is None or age >= self.cfg.binding.heartbeat_max_s:
            return "remote", None
        tr = self.presence.get(sid)
        if tr is None:
            return "remote", None
        tr.update(drt.activity)
        return tr.binding()

    # --- decisions (§5.3/§5.4) ----------------------------------------------------------------------
    async def decide(self, *, user_id: UUID, sid: str | None, action: str, amount_cents: int | None) -> DecisionRec:
        dev = self.registry.bound_device(user_id)
        drt = self.rt(dev) if dev else None
        if drt is not None and (drt.heartbeat_age() or 1e9) < self.cfg.binding.heartbeat_max_s:
            await self._wait_next_tick(drt, self.s.decision_tick_wait_s)
        binding, _score = self.binding_for(sid, drt)
        locked = bool(drt and drt.dev.locked)
        conf = drt.engine.confidence if (drt is not None and binding == "co-present") else self.cfg.anchors.remote
        learning = self.learning(drt) if drt is not None else False
        res = policy_mod.evaluate(self.cfg, action=action, amount_cents=amount_cents, confidence=conf,
                                  locked=locked, learning=learning)
        reasons = list(res.reasons)
        reasons.append(f"binding {binding}")
        if binding == "remote" and not locked:
            reasons.append("remote session: prior 0.30")
        rec = DecisionRec(
            id=uuid.uuid4(), time=utcnow(), user_id=user_id, device_id=drt.device_id if drt else None,
            session_id=drt.session_id if drt else None, web_session_id=sid, action=action,
            amount_cents=amount_cents, tier=res.tier, binding=binding, confidence=round(conf, 4),
            decision=res.decision, trans_status=res.trans_status,
            status="pending" if res.decision == "step_up" else "final", challenge_id=None, reasons=reasons,
            label=drt.label if drt else "genuine", actor=drt.actor if drt else "a",
        )
        if res.decision == "step_up":
            ch = await self._challenge_for_stepup(drt, user_id, rec.id)
            rec.challenge_id, rec.verify_url = ch.challenge_id, ch.verify_url
            if drt is not None:
                self.publish(drt, "challenge", self._challenge_live(ch))
        self.decisions[rec.id] = rec
        self.writer.insert("decisions", self._decision_row(rec))
        if drt is not None:
            self.publish(drt, "decision", rec.live())
            amt = f" ${rec.amount_cents / 100:,.0f}" if rec.amount_cents else ""
            self.feed(drt, "decision", f"{action}{amt}: {rec.trans_status} ({res.decision}, {res.tier}, "
                                       f"conf {conf:.2f}, {binding})", 2 if res.decision != "allow" else 0)
        return rec

    async def _wait_next_tick(self, drt: DeviceRuntime, timeout: float) -> None:
        start = drt.tick_count
        try:
            async with drt.tick_cond:
                await asyncio.wait_for(drt.tick_cond.wait_for(lambda: drt.tick_count > start), timeout)
        except TimeoutError:
            pass

    async def _challenge_for_stepup(self, drt: DeviceRuntime | None, user_id: UUID, decision_id: UUID) -> ChallengeOut:
        if drt is not None:
            open_ch = await self.issuer.open_for_device(drt.device_id)
            if open_ch is not None:
                if open_ch.trigger == "proactive":
                    # the first high-risk action consumes the armed challenge: same id, fresh phrase
                    return await self.issuer.refresh(open_ch.challenge_id, trigger="step_up", decision_id=decision_id)
                return open_ch  # attach to the open challenge
            return await self.issuer.issue(device_id=drt.device_id, subject_user_id=user_id,
                                           session_id=drt.session_id, trigger="step_up", decision_id=decision_id)
        return await self.issuer.issue(device_id=None, subject_user_id=user_id, session_id=None, trigger="step_up",
                                       decision_id=decision_id)

    @staticmethod
    def _decision_row(r: DecisionRec) -> dict[str, Any]:
        return {
            "id": r.id, "time": r.time, "user_id": r.user_id, "device_id": r.device_id, "session_id": r.session_id,
            "web_session_id": r.web_session_id, "action": r.action, "amount_cents": r.amount_cents, "tier": r.tier,
            "binding": r.binding, "confidence": r.confidence, "decision": r.decision,
            "trans_status": r.trans_status, "status": r.status, "challenge_id": r.challenge_id,
            "final_decision": r.final_decision, "final_trans_status": r.final_trans_status,
            "resolved_at": r.resolved_at, "reasons": r.reasons, "label": r.label, "actor": r.actor,
        }

    def _finalize(self, rec: DecisionRec, decision: str, reason: str) -> ResolvedDecision:
        ts = self.cfg.policy.trans_status[decision]
        rec.status = "final"
        rec.final_decision, rec.final_trans_status, rec.resolved_at = decision, ts, utcnow()
        rec.decision, rec.trans_status = decision, ts
        rec.reasons = [*rec.reasons, reason]
        self.writer.execute(
            "UPDATE decisions SET status='final', final_decision=$2, final_trans_status=$3, resolved_at=$4, "
            "decision=$2, trans_status=$3, reasons=$5 WHERE id=$1",
            rec.id, decision, ts, rec.resolved_at, rec.reasons,
        )
        drt = self.rt_by_id(rec.device_id)
        if drt is not None:
            self.publish(drt, "decision", rec.live())
            self.feed(drt, "decision", f"{rec.action} → {ts} ({reason})", 2 if decision == "block" else 0)
        return ResolvedDecision(decision_id=rec.id, decision=decision, trans_status=ts)

    def _resolve_attached(self, challenge_id: UUID, decision: str, reason: str) -> list[ResolvedDecision]:
        out = []
        for rec in self.decisions.values():
            if rec.challenge_id == challenge_id and rec.status == "pending":
                out.append(self._finalize(rec, decision, reason))
        return out

    # --- voice outcome (called via core.events) ---------------------------------------------------------
    async def on_challenge_status(self, challenge_id: UUID, status: str, attempt: int) -> None:
        row = await self.repo_voice.get_challenge(challenge_id)
        if row is None:
            return
        drt = self.rt_by_id(row.get("device_id"))
        cl = ChallengeLive(challenge_id=challenge_id, trigger=row["trigger"], status=status, attempt=attempt,
                           expires_at=row.get("expires_at"), verify_url=self.s.verify_url(challenge_id))
        if drt is not None:
            self.publish(drt, "challenge", cl)
            line = CHALLENGE_FEED.get(status)
            if line and row["trigger"] not in ("redteam", "sandbox"):
                self.feed(drt, "challenge", line[0].format(trigger=row["trigger"].replace("_", "-"), attempt=attempt),
                          line[1])
            if status == "fallback_mfa":
                deadline = time.monotonic() + self.cfg.resolution.mfa_timeout_s
                for rec in self.decisions.values():
                    if rec.challenge_id == challenge_id and rec.status == "pending":
                        rec.mfa_deadline = deadline
        else:
            self.live.publish(None, row.get("user_id"), "challenge", cl)

    async def on_voice_stage(self, challenge_id: UUID, data: BaseModel) -> None:
        row = await self.repo_voice.get_challenge(challenge_id)
        drt = self.rt_by_id(row.get("device_id")) if row else None
        if drt is not None:
            self.publish(drt, "voice_stage", data)
        elif row:
            self.live.publish(None, row.get("user_id"), "voice_stage", data)

    async def on_voice_decided(self, challenge_id: UUID, result: VoiceResult,
                               web_session_id: str | None) -> VoiceOutcome:
        row = await self.repo_voice.get_challenge(challenge_id)
        if row is None:
            raise HubError(404, "unknown challenge")
        trigger = row["trigger"]
        drt = self.rt_by_id(row.get("device_id"))
        live = VoiceResultLive(challenge_id=challenge_id, **result.model_dump(exclude={"spectrogram"}))
        from app.core.voice_demo import voice_mode

        if voice_mode() == "stub":  # §8 C2 stub honesty: canned/operator-chosen result, badge it
            live.simulated = True
        if drt is not None:
            self.publish(drt, "voice_result", live)
            sim = " — simulated (stub voice)" if live.simulated else ""
            self.feed(drt, "voice", f"Voice {trigger}: {result.decision} (conf {result.voice_confidence:.2f}){sim}",
                      4 if result.decision.startswith("BLOCK") else 1)
        else:
            self.live.publish(None, row.get("user_id"), "voice_result", live)
        if trigger in ("redteam", "sandbox"):
            return VoiceOutcome(device_locked=bool(drt and drt.dev.locked), resolved_decisions=[])
        resolved: list[ResolvedDecision] = []
        if result.decision == "VERIFY":
            resolved = await self._verified(drt, row, web_session_id, via="voice")
        elif result.decision in ("BLOCK_SPOOF", "BLOCK_IMPOSTOR"):
            resolved = await self._blocked(drt, row, result.decision)
        elif result.decision == "FALLBACK_MFA":
            deadline = time.monotonic() + self.cfg.resolution.mfa_timeout_s
            for rec in self.decisions.values():
                if rec.challenge_id == challenge_id and rec.status == "pending":
                    rec.mfa_deadline = deadline
        return VoiceOutcome(device_locked=bool(drt and drt.dev.locked), resolved_decisions=resolved)

    async def on_totp(self, challenge_id: UUID, ok: bool, web_session_id: str | None) -> VoiceOutcome:
        row = await self.repo_voice.get_challenge(challenge_id)
        if row is None:
            raise HubError(404, "unknown challenge")
        drt = self.rt_by_id(row.get("device_id"))
        if row["trigger"] in ("redteam", "sandbox"):
            return VoiceOutcome(device_locked=bool(drt and drt.dev.locked))
        if ok:
            resolved = await self._verified(drt, row, web_session_id, via="totp")
            return VoiceOutcome(device_locked=bool(drt and drt.dev.locked), resolved_decisions=resolved)
        resolved = []
        if drt is not None:
            n = drt.totp_failures.get(challenge_id, 0) + 1
            drt.totp_failures[challenge_id] = n
            self.feed(drt, "totp", f"TOTP failed ({n})", 3)
            # lock only on a failed TOTP after FALLBACK_MFA (one typo is forgiven)
            if row.get("status") == "fallback_mfa" and n >= 2:
                resolved = await self._blocked(drt, row, "TOTP_FAILED")
        return VoiceOutcome(device_locked=bool(drt and drt.dev.locked), resolved_decisions=resolved)

    async def _verified(self, drt: DeviceRuntime | None, row: dict, web_sid: str | None,
                        via: str) -> list[ResolvedDecision]:
        now = utcnow()
        if drt is not None:
            # an admin lock is an explicit human decision: only /admin/actions unlock (or /demo/reset) clears it
            if row["trigger"] == "unlock" and drt.dev.locked and drt.dev.lock_reason != ADMIN_LOCK:
                drt.dev.locked, drt.dev.locked_at, drt.dev.lock_reason = False, None, None
                self.registry.save_device(drt.dev)
                await self.send_agent(drt, AgentUnlock())
                self.publish(drt, "unlock", {})
                self.feed(drt, "lock", f"Device unlocked by {via}", 1)
            if row["trigger"] == "unlock" and not drt.dev.locked and drt.label == "impostor":
                # the owner's unlock VERIFY ends the open takeover: A's next actions are stamped genuine/a,
                # the stage button flips back to "Mark takeover", and the label-aware stub default is VERIFY again
                await self.add_marker(drt, "takeover_end", None,
                                      f"owner verified by {'voice' if via == 'voice' else 'TOTP'}",
                                      source=f"{via} unlock")
            if not drt.dev.locked:
                drt.engine.anchor(self.cfg.anchors.verify)
                drt.in_takeover = drt.failed_challenge = False
                drt.below, drt.rearm_ok = 0, True
                drt.last_verify_at = now
                tl = self._push_trust(drt, [f"{via}_verify"])
                await self._agent_trust(drt, tl)
        out = []
        for rec in list(self.decisions.values()):
            if rec.challenge_id != row["id"] or rec.status != "pending":
                continue
            ok = (
                rec.user_id == row["user_id"] and web_sid is not None and rec.web_session_id == web_sid
                and (now - rec.time).total_seconds() <= self.cfg.resolution.verify_window_s
                and (drt is None or drt.last_block_event_at is None or drt.last_block_event_at < rec.time)
            )
            out.append(self._finalize(rec, "allow" if ok else "block",
                                      f"{via}_verified" if ok else "verify_conditions_not_met"))
        return out

    async def _blocked(self, drt: DeviceRuntime | None, row: dict, decision: str) -> list[ResolvedDecision]:
        kind = {"BLOCK_SPOOF": "voice_spoof", "BLOCK_IMPOSTOR": "voice_impostor"}.get(decision, "lock")
        if drt is not None:
            before = drt.engine.confidence
            drt.last_block_event_at = utcnow()
            drt.failed_challenge = True
            self._revoke_update_candidates(drt, drt.last_block_event_at, decision)
            if row["trigger"] in ("proactive", "step_up") or decision == "TOTP_FAILED":
                drt.dev.locked, drt.dev.locked_at, drt.dev.lock_reason = True, utcnow(), kind
                self.registry.save_device(drt.dev)
                drt.engine.pin_min()
                tl = self._push_trust(drt, [kind])
                await self.send_agent(drt, AgentLock(reason=kind))
                await self._agent_trust(drt, tl)
                self.publish(drt, "lock", LockLive(reason=kind))
                self.feed(drt, "lock", f"Device LOCKED ({kind})", 5)
                subject = self.registry.users.get(row["user_id"])
                if subject is not None and subject.role != "admin":
                    self.registry.revoke_user_sessions(subject.id)
                    self.live.close_user(subject.id)
                # a voice verdict is not a behavioral one: the deviations belong to the takeover anomaly
                top = [] if kind in ("voice_spoof", "voice_impostor") else drt.last_top
                self.anomaly(drt, kind, 5, before, drt.engine.confidence, top, action="lock",
                             challenge_id=row["id"])
            else:  # BLOCK_* on an unlock challenge: stays locked, severity-5 anomaly
                self.anomaly(drt, kind, 5, before, drt.engine.confidence, [], action="unlock_denied",
                             challenge_id=row["id"])
        return self._resolve_attached(row["id"], "block", decision.lower())

    def can_request_unlock(self, device_id: UUID, session_created_at: datetime | None) -> bool:
        drt = self.rt_by_id(device_id)
        if drt is not None and drt.dev.locked and drt.dev.lock_reason == ADMIN_LOCK:
            raise HubError(409, "locked by your admin: only an admin can unlock this device")
        if drt is None or not drt.dev.locked or session_created_at is None or drt.dev.locked_at is None:
            return False
        return session_created_at > drt.dev.locked_at

    # --- snapshot / health -------------------------------------------------------------------------------
    def snapshot(self, drt: DeviceRuntime | None) -> Snapshot:
        if drt is None:
            return Snapshot(device=None, session_id=None, label="genuine", actor="a", trust=None)
        now = utcnow()
        d = drt.dev
        open_rows = self.repo_voice.open_for_device(d.id)
        oc = None
        if open_rows:
            r = open_rows[0]
            oc = ChallengeLive(challenge_id=r["id"], trigger=r["trigger"], status=r["status"], attempt=r["attempt"],
                               expires_at=r.get("expires_at"), verify_url=self.s.verify_url(r["id"]))
        trust = drt.trust or self._trust_live(drt, drt.engine.snapshot_state(time.time()), None)
        return Snapshot(
            device=LiveDevice(id=d.id, label=d.label, pointer=d.pointer, mode=d.mode, locked=d.locked,
                              lock_reason=d.lock_reason, last_seen=d.last_seen),
            session_id=drt.session_id, label=drt.label, actor=drt.actor, trust=trust,
            trust_history=[p for p in drt.history if (now - p.t).total_seconds() <= HISTORY_S],
            markers=[m for m in drt.markers if (now - m.t).total_seconds() <= HISTORY_S],
            model=self.models.model_info(d.user_id), enroll=self.enroll_progress(drt), open_challenge=oc,
            recent_events=list(reversed(drt.feed)), last_tick_json=drt.last_tick_json, health=self.health(drt),
            enrolled_psd=self.models.enrolled_psd.get(d.user_id),
            recent_blocks=[b for b in drt.recent_blocks if (now - b.t_end).total_seconds() <= 120],
        )

    def health(self, drt: DeviceRuntime) -> HealthLive:
        from app.core.runtime import rt

        now = utcnow()
        try:
            r = rt()
            warm, quota = r.voice_warm, r.extras.get("elevenlabs_quota")
        except RuntimeError:
            warm, quota = False, None
        base = int(now.timestamp())
        return HealthLive(
            heartbeat_age_s=drt.heartbeat_age(), tap_events_per_s=drt.tap_rate, secure_input=drt.secure_input,
            last_block_age_s={m: (now - t).total_seconds() for m, t in drt.last_block_at.items()},
            rtt_ms=drt.rtt_ms, voice_warm=warm, elevenlabs_quota=quota,
            activity=[drt.activity.get(base - 30 + i, 0) for i in range(30)],
        )

    def _maybe_health(self, drt: DeviceRuntime, force: bool = False) -> None:
        h = self.health(drt)
        if force:  # per-tick: carry the literal payload for the "What left this laptop" drawer
            h.last_tick_json = drt.last_tick_json
        self.publish(drt, "health", h)

    # --- periodic loop -------------------------------------------------------------------------------------
    async def _loop(self) -> None:
        last_mirror = 0.0
        last_health = 0.0
        while True:
            await asyncio.sleep(1.0)
            try:
                await self._tick_loop(last_health)
                mono = time.monotonic()
                if mono - last_health >= 5:
                    last_health = mono
                    for drt in self.devices.values():
                        self._maybe_health(drt)
                if mono - last_mirror >= 2:
                    last_mirror = mono
                    self.registry.save_mirror()
            except Exception:
                log.exception("hub loop error")

    async def _tick_loop(self, _last_health: float) -> None:
        now = utcnow()
        mono = time.monotonic()
        for drt in list(self.devices.values()):
            for row in self.repo_voice.open_for_device(drt.device_id, now):
                exp = row.get("expires_at")
                if exp is not None and exp < now:
                    with contextlib.suppress(Exception):
                        await self.issuer.expire(row["id"])
                    self._resolve_attached(row["id"], "block", "challenge_expired")
                    if row["trigger"] == "proactive":
                        self.feed(drt, "challenge", "Proactive challenge expired (no lock; actions keep stepping up)", 3)
            if (drt.agent_ws is None and drt.agent_disconnected_at is not None and drt.session_id is not None
                    and mono - drt.agent_disconnected_at > self.cfg.session.end_after_ws_close_s):
                self._end_session(drt, "ws_timeout")
        for rec in list(self.decisions.values()):
            if rec.status == "pending" and rec.mfa_deadline is not None and mono > rec.mfa_deadline:
                self._finalize(rec, "block", "mfa_timeout")
        # bound the in-memory decision log
        if len(self.decisions) > 2000:
            for k in sorted(self.decisions, key=lambda k: self.decisions[k].time)[:500]:
                if self.decisions[k].status == "final":
                    self.decisions.pop(k, None)


def trust_display(conf: float) -> int:
    return min(99, round(100 * conf)) if math.isfinite(conf) else 0
