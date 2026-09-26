"""Every cross-package DTO (§5.6). Pure pydantic, no numpy. Owner: Claude. Frozen at CP0.

Wire timestamps are UTC ISO-8601 with milliseconds and a `Z` suffix (§5.2). `UtcDatetime`
parses any ISO string (naive = UTC) and always serializes as `YYYY-MM-DDTHH:MM:SS.mmmZ`.

Privacy (§2.2): agent->server wire models use extra='forbid' so nothing beyond the contract
(keycodes, titles, bundle IDs, coordinates) can ride along in a tick.
Post-CP0: adding an optional field = CHANGELOG line; rename/remove = CONTRACT: commit.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    PlainSerializer,
    WithJsonSchema,
)

# ---------------------------------------------------------------------------
# Scalars
# ---------------------------------------------------------------------------


def _to_utc(d: datetime) -> datetime:
    return d.replace(tzinfo=UTC) if d.tzinfo is None else d.astimezone(UTC)


def iso_ms(d: datetime) -> str:
    d = _to_utc(d)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def utcnow() -> datetime:
    return datetime.now(UTC)


UtcDatetime = Annotated[
    datetime,
    AfterValidator(_to_utc),
    PlainSerializer(iso_ms, return_type=str, when_used="json"),
    WithJsonSchema({"type": "string", "format": "date-time"}),
]

Modality = Literal["keyboard", "mouse", "scroll", "workflow", "temporal"]
MODALITIES: tuple[Modality, ...] = ("keyboard", "mouse", "scroll", "workflow", "temporal")
Mode = Literal["enroll", "monitor"]
Label = Literal["genuine", "impostor"]
Actor = Literal["a", "b", "guest"]
Pointer = Literal["trackpad", "mouse"]
Level = Literal["learning", "normal", "watch", "suspicious", "locked"]
Binding = Literal["co-present", "remote"]
Channel = Literal["desktop", "web"]
Role = Literal["user", "admin"]  # admin sessions are observer sessions (§2.3)
MarkerLabel = Literal["takeover_start", "takeover_end", "note", "rearm", "reset"]
OsEventKind = Literal["screen_locked", "screen_unlocked", "sleep", "wake"]
ChallengeTrigger = Literal["proactive", "step_up", "unlock", "redteam", "sandbox"]
ChallengeStatus = Literal[
    "issued",          # row + phrase exist (proactive: armed)
    "prompt_ended",    # ChallengeFlow reported the prompt audio `ended`
    "scoring",
    "retry",           # awaiting another attempt (new phrase)
    "fallback_mfa",    # awaiting TOTP
    "verified",
    "blocked_spoof",
    "blocked_impostor",
    "expired",
    "cancelled",
]
VoiceDecision = Literal["VERIFY", "RETRY", "FALLBACK_MFA", "BLOCK_SPOOF", "BLOCK_IMPOSTOR"]
DecisionAction = Literal["view", "export", "add_payee", "password_change", "purchase"]
DecisionKind = Literal["allow", "step_up", "block"]
TransStatus = Literal["Y", "C", "N"]
Tier = Literal["R0", "R1", "R2", "R3"]
AnomalyKind = Literal[
    "trust_drop", "takeover_suspected", "voice_spoof", "voice_impostor", "lock", "redteam_tool"
]
ModelStatus = Literal["none", "training", "ready", "failed"]


class _Wire(BaseModel):
    """Strict wire model: unknown fields are rejected (privacy boundary)."""

    model_config = ConfigDict(extra="forbid")


class _Dto(BaseModel):
    model_config = ConfigDict(extra="ignore")


# ---------------------------------------------------------------------------
# Core signal types (§5.6)
# ---------------------------------------------------------------------------


class Display(_Wire):
    w_pt: float
    h_pt: float
    hz: int


class Block(_Wire):
    modality: Modality
    t_start: UtcDatetime
    t_end: UtcDatetime
    n: int = Field(ge=0)
    # EXACTLY spec.names(modality); null = insufficient evidence
    features: dict[str, float | None]
    # workflow only: category transitions, e.g. {"ide>browser": 2}
    transitions: dict[str, int] | None = None
    # temporal context only: log PSD 0-25 Hz, 32 bins
    psd: list[float] | None = None


class Deviation(_Dto):
    feature: str
    z: float  # robust z = (x - median) / (1.4826 * MAD)


class BlockScore(_Dto):
    modality: Modality
    t_end: UtcDatetime
    n: int
    typicality: float | None
    llr_direct: float | None = None
    top: list[Deviation] = Field(default_factory=list)


class ModalityContribution(_Dto):
    typicality: float | None
    llr: float
    q: float
    w: float
    delta: float
    n_blocks: int


class TrustState(_Dto):
    t: float  # epoch seconds of the tick end
    logit: float
    delta_logit: float
    confidence: float
    display: int
    level: Level
    per_modality: dict[Modality, ModalityContribution] = Field(default_factory=dict)
    reasons: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Agent <-> /ws/agent (§5.2)
# ---------------------------------------------------------------------------


class Hello(_Wire):
    type: Literal["hello"] = "hello"
    v: int = 1
    device_token: str
    run_id: UUID
    resume_session_id: UUID | None = None
    requested_mode: Mode | None = None
    agent_version: str
    schema_version: int
    os: str
    pointer: Pointer
    display: Display
    last_unlock_at: UtcDatetime | None = None


class TickFlags(_Wire):
    secure_input: bool = False
    injected: int = 0
    pointer: Pointer = "trackpad"
    late: bool = False
    idle_s: float = 0.0
    clock_skew: bool = False
    # lowest-RTT clock_ping sample (ms) — feeds the dashboard RTT pill (post-CP0 additive)
    rtt_ms: float | None = None


class TickCounts(_Wire):
    keys: int = 0
    mouse_moves: int = 0
    clicks: int = 0
    scroll_events: int = 0
    app_switches: int = 0


class Tick(_Wire):
    type: Literal["tick"] = "tick"
    run_id: UUID
    session_id: UUID | None = None
    seq: int = Field(ge=0)
    t_end: UtcDatetime
    flags: TickFlags = Field(default_factory=TickFlags)
    counts: TickCounts = Field(default_factory=TickCounts)
    # input events per 1 s bucket over the tick (sparkline + co-presence; not stored)
    activity: list[int] = Field(default_factory=list)
    blocks: list[Block] = Field(default_factory=list)
    context: Block | None = None


class MarkerMsg(_Wire):
    type: Literal["marker"] = "marker"
    label: Literal["takeover_start", "takeover_end", "note"]
    t: UtcDatetime
    text: str | None = None


class OsEventMsg(_Wire):
    type: Literal["os_event"] = "os_event"
    event: OsEventKind
    t: UtcDatetime


class DemoMsg(_Wire):
    type: Literal["demo"] = "demo"
    action: Literal["reset"]


class ClockPing(_Wire):
    type: Literal["clock_ping"] = "clock_ping"
    t0_ns: int


AgentMessage = Annotated[
    Hello | Tick | MarkerMsg | OsEventMsg | DemoMsg | ClockPing, Field(discriminator="type")
]


class AgentTicksIn(_Wire):
    """POST /api/agent/ticks — HTTPS fallback while the WS is down (Bearer device token)."""

    ticks: list[Tick]


class AgentTicksOut(_Dto):
    accepted: int
    duplicates: int


# server -> agent


class Welcome(_Dto):
    type: Literal["welcome"] = "welcome"
    device_id: UUID
    user_id: UUID
    session_id: UUID
    mode: Mode
    model_version: int | None
    label: Label
    actor: Actor


class AgentModalityTrust(_Dto):
    llr: float
    delta: float


class AgentTrust(_Dto):
    type: Literal["trust"] = "trust"
    seq: int | None
    confidence: float
    display: int
    level: Level
    locked: bool
    per_modality: dict[Modality, AgentModalityTrust] = Field(default_factory=dict)


class AgentChallenge(_Dto):
    type: Literal["challenge"] = "challenge"
    challenge_id: UUID
    trigger: ChallengeTrigger
    verify_url: str
    expires_at: UtcDatetime | None
    # server-computed: true when no browser bound to this device had /ws/live in the last 15 s,
    # so the agent should `open verify_url` itself (otherwise: notification only)
    open_browser: bool = False


class AgentLock(_Dto):
    type: Literal["lock"] = "lock"
    reason: str


class AgentUnlock(_Dto):
    type: Literal["unlock"] = "unlock"


class AgentMode(_Dto):
    type: Literal["mode"] = "mode"
    mode: Mode


class ClockPong(_Dto):
    type: Literal["clock_pong"] = "clock_pong"
    t0_ns: int
    server_ns: int


class AgentError(_Dto):
    type: Literal["error"] = "error"
    code: str
    detail: str | None = None


ServerToAgent = Annotated[
    Welcome | AgentTrust | AgentChallenge | AgentLock | AgentUnlock | AgentMode | ClockPong | AgentError,
    Field(discriminator="type"),
]

# ---------------------------------------------------------------------------
# Voice (§5.6; service = Codex 2)
# ---------------------------------------------------------------------------


class Spectrogram(_Dto):
    f_hz: list[float]
    t_s: list[float]
    db: list[list[float]]  # 64 x 128


class VoiceResult(_Dto):
    decision: VoiceDecision
    voice_confidence: float
    asv_cos: float | None
    cm_p_spoof: float | None
    spec_sim: float | None
    phrase_wer: float | None
    onset_ms: int | None
    dsp: dict[str, float] = Field(default_factory=dict)
    findings: list[str] = Field(default_factory=list)
    stage_ms: dict[str, int] = Field(default_factory=dict)
    spectrogram: Spectrogram | None = None


class ChallengeOut(_Dto):
    challenge_id: UUID
    trigger: ChallengeTrigger
    status: ChallengeStatus
    attempt: int
    phrase: str
    prompt_url: str
    expires_at: UtcDatetime | None
    verify_url: str


class ResolvedDecision(_Dto):
    decision_id: UUID
    decision: DecisionKind
    trans_status: TransStatus


class VoiceOutcome(_Dto):
    device_locked: bool
    resolved_decisions: list[ResolvedDecision] = Field(default_factory=list)


class CMResult(_Dto):
    """hearsay.score_audio(...) result (profile 'stepup' | 'hearsay')."""

    margin: float
    p_spoof: float | None = None
    llr: float | None = None
    analyzers: dict[str, float] = Field(default_factory=dict)
    ms: dict[str, float] = Field(default_factory=dict)


class VoiceEnrollStartOut(_Dto):
    enroll_id: UUID
    phrases: list[str]


class VoiceEnrollOut(_Dto):
    enrolled: bool
    n_utts: int
    intra_cos: float | None


class ChallengeCreateIn(_Dto):
    reason: Literal["unlock", "redteam", "sandbox"]


class NextPhrase(_Dto):
    phrase: str
    prompt_url: str
    expires_at: UtcDatetime | None
    attempt: int


class ChallengeResponseOut(_Dto):
    result: VoiceResult
    outcome: VoiceOutcome
    next: NextPhrase | None = None


class TotpVerifyIn(_Dto):
    challenge_id: UUID
    code: str


class TotpVerifyOut(_Dto):
    ok: bool
    outcome: VoiceOutcome


class TotpEnrollOut(_Dto):
    otpauth_uri: str


class RedteamActiveOut(_Dto):
    challenge_id: UUID
    phrase: str
    status: ChallengeStatus


# ---------------------------------------------------------------------------
# Auth, devices, presence (§5.3)
# ---------------------------------------------------------------------------


class LoginIn(_Dto):
    email: str
    password: str


class DeviceOut(_Dto):
    id: UUID
    label: str
    pointer: Pointer | None = None
    mode: Mode
    locked: bool
    lock_reason: str | None = None
    last_seen: UtcDatetime | None = None


class MeOut(_Dto):
    user_id: UUID
    email: str
    handle: str
    role: Role
    totp_enrolled: bool = False
    device: DeviceOut | None = None


class DeviceRegisterIn(_Dto):
    label: str = "MacBook"
    os: str | None = None
    pointer: Pointer | None = None
    display: Display | None = None


class DeviceRegisterOut(_Dto):
    device_id: UUID
    device_token: str


class PresenceBucket(_Dto):
    t_s: int  # epoch second
    keys: int = 0
    pointer: int = 0
    wheel: int = 0


class PresenceIn(_Dto):
    buckets: list[PresenceBucket]
    # Date.now() at send; the server uses it to correct the browser clock offset
    client_now_ms: int | None = None


class PresenceOut(_Dto):
    binding: Binding
    score: float | None
    device_id: UUID | None = None


# ---------------------------------------------------------------------------
# Enroll and models (§5.3)
# ---------------------------------------------------------------------------


class EnrollModeIn(_Dto):
    device_id: UUID
    mode: Mode


class EnrollTrainIn(_Dto):
    device_id: UUID
    source: Literal["tiger", "logs"] = "tiger"


class RetrainIn(_Dto):
    device_id: UUID


class JobOut(_Dto):
    job_id: UUID


class EnrollProgress(_Dto):
    mode: Mode
    counts: dict[Modality, int]
    gates: dict[Modality, int]
    ready: bool


class ModelInfo(_Dto):
    status: ModelStatus
    job_id: UUID | None = None
    version: int | None = None
    trained_at: UtcDatetime | None = None
    n_blocks: dict[Modality, int] = Field(default_factory=dict)
    enabled_modalities: list[Modality] = Field(default_factory=list)
    metrics: dict[str, Any] = Field(default_factory=dict)
    headline_medians: dict[str, float | None] = Field(default_factory=dict)
    learned_since_enroll: int = 0
    parent_version: int | None = None
    error: str | None = None


# ---------------------------------------------------------------------------
# Decisions (§5.3, §5.4)
# ---------------------------------------------------------------------------


class DecisionIn(_Dto):
    action: DecisionAction
    amount_cents: int | None = None


class CheckoutIn(_Dto):
    amount_cents: int
    card_last4: str = Field(pattern=r"^\d{4}$")


class DecisionOut(_Dto):
    decision_id: UUID
    status: Literal["final", "pending"]
    decision: DecisionKind
    trans_status: TransStatus
    confidence: float
    tier: Tier
    binding: Binding
    reasons: list[str] = Field(default_factory=list)
    challenge_id: UUID | None = None
    verify_url: str | None = None


class DecisionDetailOut(DecisionOut):
    action: DecisionAction
    amount_cents: int | None = None
    final_decision: DecisionKind | None = None
    final_trans_status: TransStatus | None = None
    resolved_at: UtcDatetime | None = None


# ---------------------------------------------------------------------------
# Demo / admin (§5.3)
# ---------------------------------------------------------------------------


class DemoLabelIn(_Dto):
    device_id: UUID
    label: Label
    actor: Actor


class DemoMarkerIn(_Dto):
    device_id: UUID
    label: MarkerLabel
    text: str | None = None


class DemoDeviceIn(_Dto):
    device_id: UUID


class DemoRearmIn(_Dto):
    device_id: UUID
    confidence: float = Field(default=0.31, gt=0.0, lt=1.0)


class PurgeSessionIn(_Dto):
    session_id: UUID


class OkOut(_Dto):
    ok: bool = True
    detail: str | None = None


# ---------------------------------------------------------------------------
# /ws/live (§5.2) — envelope {type, device_id, t, data}
# ---------------------------------------------------------------------------


class TrustPoint(_Dto):
    t: UtcDatetime
    confidence: float
    level: Level


class MarkerPoint(_Dto):
    t: UtcDatetime
    label: MarkerLabel
    text: str | None = None


class DeviationOut(_Dto):
    feature: str
    label: str
    unit: str
    z: float


class LiveDevice(_Dto):
    id: UUID
    label: str
    pointer: Pointer | None
    mode: Mode
    locked: bool
    lock_reason: str | None
    last_seen: UtcDatetime | None


class TrustLive(TrustState):
    seq: int | None = None
    locked: bool = False


class BlockScored(_Dto):
    modality: Modality
    t_start: UtcDatetime
    t_end: UtcDatetime
    n: int
    typicality: float | None
    llr: float | None
    q: float | None
    delta: float | None
    top: list[DeviationOut] = Field(default_factory=list)


class ContextLive(_Dto):
    psd: list[float] | None
    features: dict[str, float | None]
    # A's enrolled mean log PSD for the "Rhythm spectrum (FFT)" comparison
    enrolled_psd: list[float] | None = None


class AnomalyLive(_Dto):
    id: UUID
    kind: AnomalyKind
    severity: int = Field(ge=1, le=5)
    trust_before: float | None
    trust_after: float | None
    top_features: list[DeviationOut] = Field(default_factory=list)
    action: str | None = None
    challenge_id: UUID | None = None
    explanation: str | None = None


class ChallengeLive(_Dto):
    challenge_id: UUID
    trigger: ChallengeTrigger
    status: ChallengeStatus
    attempt: int
    expires_at: UtcDatetime | None
    verify_url: str | None = None


class VoiceResultLive(_Dto):
    """VoiceResult without the spectrogram, plus challenge_id."""

    challenge_id: UUID
    decision: VoiceDecision
    voice_confidence: float
    asv_cos: float | None
    cm_p_spoof: float | None
    spec_sim: float | None
    phrase_wer: float | None
    onset_ms: int | None
    dsp: dict[str, float] = Field(default_factory=dict)
    findings: list[str] = Field(default_factory=list)
    stage_ms: dict[str, int] = Field(default_factory=dict)


class VoiceStageLive(_Dto):
    """Streaming step-up stage (transcribing -> anti-spoof -> speaker -> spectral)."""

    challenge_id: UUID
    stage: Literal["transcribing", "anti-spoof", "speaker", "spectral", "done"]
    ok: bool | None = None
    value: float | None = None


class DecisionLive(DecisionOut):
    action: DecisionAction
    amount_cents: int | None = None


class ModeLive(_Dto):
    mode: Mode


class LockLive(_Dto):
    reason: str


class LabelLive(_Dto):
    label: Label
    actor: Actor


class PresenceLive(_Dto):
    binding: Binding
    score: float | None


class HealthLive(_Dto):
    """Dashboard health pills."""

    heartbeat_age_s: float | None
    tap_events_per_s: float | None
    secure_input: bool
    last_block_age_s: dict[Modality, float | None] = Field(default_factory=dict)
    rtt_ms: float | None = None
    voice_warm: bool = False
    elevenlabs_quota: float | None = None  # fraction used, amber at 0.8
    activity: list[int] = Field(default_factory=list)
    # the literal last tick payload ("What left this laptop"); set on per-tick health events
    last_tick_json: dict[str, Any] | None = None


class FeedItem(_Dto):
    t: UtcDatetime
    type: str
    text: str
    severity: int = 0


class Snapshot(_Dto):
    device: LiveDevice | None
    session_id: UUID | None
    label: Label
    actor: Actor
    trust: TrustLive | None
    trust_history: list[TrustPoint] = Field(default_factory=list)  # 10 min
    markers: list[MarkerPoint] = Field(default_factory=list)  # 10 min
    model: ModelInfo | None = None
    enroll: EnrollProgress | None = None
    open_challenge: ChallengeLive | None = None
    recent_events: list[FeedItem] = Field(default_factory=list)  # <= 50
    last_tick_json: dict[str, Any] | None = None  # "What left this laptop"
    health: HealthLive | None = None
    enrolled_psd: list[float] | None = None


LiveType = Literal[
    "snapshot", "trust", "block_scored", "context", "enroll_progress", "model", "anomaly",
    "challenge", "voice_stage", "voice_result", "decision", "marker", "mode", "lock", "unlock",
    "label", "presence", "health", "feed",
]


class LiveEnvelope(_Dto):
    type: LiveType
    device_id: UUID | None
    t: UtcDatetime
    data: dict[str, Any]


# type -> payload model (used by core_gen_ts.py to emit the TS discriminated union)
LIVE_PAYLOADS: dict[str, type[BaseModel] | None] = {
    "snapshot": Snapshot,
    "trust": TrustLive,
    "block_scored": BlockScored,
    "context": ContextLive,
    "enroll_progress": EnrollProgress,
    "model": ModelInfo,
    "anomaly": AnomalyLive,
    "challenge": ChallengeLive,
    "voice_stage": VoiceStageLive,
    "voice_result": VoiceResultLive,
    "decision": DecisionLive,
    "marker": MarkerPoint,
    "mode": ModeLive,
    "lock": LockLive,
    "unlock": None,
    "label": LabelLive,
    "presence": PresenceLive,
    "health": HealthLive,
    "feed": FeedItem,
}

# ---------------------------------------------------------------------------
# History / Tiger (§5.3, §6 A2)
# ---------------------------------------------------------------------------


class SessionRow(_Dto):
    session_id: UUID
    device_id: UUID | None
    user_id: UUID
    channel: Channel
    status: str
    started_at: UtcDatetime
    ended_at: UtcDatetime | None
    n_ticks: int = 0
    avg_confidence: float | None = None
    min_confidence: float | None = None
    n_anomalies: int = 0
    n_markers: int = 0


class TrustBucket(_Dto):
    t: UtcDatetime
    avg: float | None
    min: float | None
    max: float | None
    last: float | None
    n_stepups: int = 0


class TrustSeries(_Dto):
    session_id: UUID | None
    bucket: str
    points: list[TrustBucket]
    markers: list[MarkerPoint] = Field(default_factory=list)


class AnomalyRow(_Dto):
    id: UUID
    time: UtcDatetime
    kind: AnomalyKind
    severity: int
    device_id: UUID | None
    session_id: UUID | None
    trust_before: float | None
    trust_after: float | None
    top_features: list[DeviationOut] = Field(default_factory=list)
    action: str | None
    challenge_id: UUID | None
    challenge_decision: str | None = None
    explanation: str | None
    resolution: str | None


class BaselineRow(_Dto):
    feature: str
    column: str
    label: str
    unit: str
    session_median: float | None
    baseline_mean: float | None
    baseline_std: float | None
    z: float | None


class BaselineOut(_Dto):
    modality: Modality
    session_id: UUID | None
    rows: list[BaselineRow]


class HypertableStat(_Dto):
    name: str
    total_chunks: int
    compressed_chunks: int
    before_bytes: int | None
    after_bytes: int | None
    ratio: float | None
    rows_estimate: int | None = None


class TigerJob(_Dto):
    job_id: int
    proc: str
    hypertable: str | None
    schedule_interval: str | None
    last_run_status: str | None
    next_start: UtcDatetime | None


class TigerStats(_Dto):
    ok: bool
    hypertables: list[HypertableStat] = Field(default_factory=list)
    jobs: list[TigerJob] = Field(default_factory=list)
    caggs: list[str] = Field(default_factory=list)
    extensions: dict[str, str] = Field(default_factory=dict)
    cached_at: UtcDatetime | None = None


class DriftRow(_Dto):
    t: UtcDatetime
    column: str
    z: float | None


class WriterStats(_Dto):
    queued: int
    dropped: int
    flushed: int
    failed_batches: int
    last_flush_at: UtcDatetime | None


class StatusOut(_Dto):
    ok: bool
    version: str
    uptime_s: float
    tiger: Literal["up", "down"]
    voice_warm: bool
    demo_mode: bool
    continuous_update: bool
    writer: WriterStats
    devices_online: int
    elevenlabs: dict[str, Any] | None = None
    inference: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Reports (§5.8). JSON Schemas are generated into contracts/schemas/.
# ---------------------------------------------------------------------------


class EvalModality(_Dto):
    auc: float | None
    eer: float | None
    roc: list[tuple[float, float]] = Field(default_factory=list, max_length=200)
    n_genuine: int
    n_impostor: int
    beta: float | None = None
    weak: bool = False


class EvalFused(_Dto):
    auc: float | None
    eer: float | None


class EvalAblation(_Dto):
    removed: Modality
    fused_eer: float | None


class EvalIdentification(_Dto):
    labels: list[str]
    confusion: list[list[int]]
    accuracy: float | None


class EvalLiveTrial(_Dto):
    t_start: UtcDatetime
    ttd_s: float | None
    detected: bool


class EvalSpliceTtd(_Dto):
    median: float | None
    p90: float | None
    values: list[float] = Field(default_factory=list)


class EvalSplice(_Dto):
    n: int
    ttd_s: EvalSpliceTtd
    undetected_300s_frac: float | None
    fa_per_hour: dict[str, float]
    r3_friction_frac: float | None


class EvalReport(_Dto):
    generated_at: UtcDatetime
    n_blocks: dict[str, dict[str, int]]  # {"a": {modality: n}, "b": {...}}
    modalities: dict[Modality, EvalModality]
    fused: EvalFused
    ablation: list[EvalAblation] = Field(default_factory=list)
    identification: EvalIdentification | None = None
    live_trials: list[EvalLiveTrial] = Field(default_factory=list)
    splice: EvalSplice | None = None  # P1
    notes: list[str] = Field(default_factory=list)


class RedteamCount(_Dto):
    n: int
    frr: float | None = None
    far: float | None = None


class RedteamAttack(_Dto):
    # e.g. "tts_flash", "tts_multilingual", "sts", "replay", "premade"
    attack_class: str = Field(alias="class")
    generator: str
    n: int
    far_asv_only: float | None
    far_cm_only: float | None
    far_fused: float | None
    mean_asv_cos: float | None

    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class RedteamReport(_Dto):
    generated_at: UtcDatetime
    delivery: Literal["acoustic", "injected"]
    thresholds: dict[str, float]
    genuine: RedteamCount
    impostor: RedteamCount
    attacks: list[RedteamAttack] = Field(default_factory=list)


class HearsayDev(_Dto):
    n: int
    min_dcf_a: float | None
    min_dcf_b: float | None
    eer: float | None


class HearsayDetector(_Dto):
    name: str
    min_dcf_a: float | None
    min_dcf_b: float | None


class HearsayReport(_Dto):
    generated_at: UtcDatetime
    rules_confirmed: bool
    dev: HearsayDev
    detectors: list[HearsayDetector] = Field(default_factory=list)
    fusion: dict[str, Any] | str | None = None
    ablation: list[dict[str, Any]] = Field(default_factory=list)


REPORT_MODELS: dict[str, type[BaseModel]] = {
    "eval": EvalReport,
    "redteam": RedteamReport,
    "hearsay": HearsayReport,
}
