# Contract changelog

Post-CP0 rules (§0): additive changes (nullable feature, optional field, new enum value) need one line here.
Renames/removals need a `CONTRACT:` commit by Claude plus a ping to the other agents.

Format: `- YYYY-MM-DD HH:MM ET · <who> · <file/type> · <change>`

## v1 (CP0, tag `cp0-contracts`)
- 2026-09-26 02:30 ET · Claude · all · initial freeze: feature_spec.yaml v1 (80 features, 15 headline), trust_config.yaml v1,
  messages.md, api.md, event_log.md, twobme_common.types, report schemas.
- Notes on decisions made while writing v1 (not in IMPLEMENTATION.md verbatim):
  - `wf.markov_ll` is in `names(workflow)` with `derived: model` — the agent always sends null; UserModel fills it.
  - Enrollment gates live in `feature_spec.yaml` (`enroll_gate` per modality); n_ref lives only there too
    (`load_trust_config()` merges it into `TrustConfig.n_ref`).
  - `Actor` = `a|b|guest` (`guest` = judge/volunteer ephemeral sessions, never trained on).
  - Extra live event types beyond §5.2: `voice_stage` (C2 stage streaming), `health` (dashboard pills), `feed` (event feed).
  - `TotpVerifyOut{ok, outcome}` and server-side `events.totp_decided(...)` resolve FALLBACK_MFA decisions.
  - Agent `error` message `{code, detail}`; WS close codes 4401 (auth) / 4409 (superseded); `/ws/live` also closes 4401 without a cookie.
  - `HealthLive.last_tick_json` (per-tick health events carry the literal payload for "What left this laptop");
    `PresenceIn.client_now_ms` (browser clock-offset correction); `AgentChallenge.open_browser`.
  - Semantics: `FeedItem.severity` 0 info · 1 notice · 2 warn · 3+ alert (5 = lock); `ModelInfo.headline_medians` keyed by
    headline column (`kb_hold_p50`); temporal `psd` = 32 bins evenly spaced 0–25 Hz.

## post-CP0 (additive)
- 2026-09-26 02:05 ET · Claude · `TickFlags.rtt_ms: float|null` — agent's lowest-RTT clock_ping sample (ms) for the dashboard RTT pill.
