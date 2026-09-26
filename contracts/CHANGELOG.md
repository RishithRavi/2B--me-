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
- 2026-09-26 02:15 ET · Claude · `voice_profiles.mfcc_mean vector(20)` (migration 005) + `repo_voice.insert_profile(mfcc_mean=...)`:
  `spec_sim = cosine([LTAS64 ‖ MFCC-mean20], [profile.spectral_summary ‖ profile.mfcc_mean])`; `spectral_summary` stays the 64-bin LTAS.
- 2026-09-26 02:35 ET · Claude · `Snapshot.recent_blocks: BlockScored[]` (last 2 min) so TTD counts / why-chips survive a reload.
- 2026-09-26 02:35 ET · Claude · clarification: temporal `psd` is **log10** Welch power per bin (32 bins, 0–25 Hz evenly spaced).
- 2026-09-26 02:35 ET · Claude · clarification: `client_prompt_end_ms` (voice response) = ms from recorder start (mic open) to the
  prompt's `ended` event. The uploaded WAV already starts at prompt end — the server must NOT trim by this value; use it only
  for latency/onset diagnostics.

## post-CP0 (value changes; `CONTRACT:` commits)
- 2026-09-26 18:30 ET · Claude · `feature_spec.yaml` · workflow `enroll_gate` 20 → 13. Workflow now trains once an enrollment has
  13 minutes that contain an app or window change. `twobme_ml` reads every gate from the spec (`enrollment_gates`), and the
  per-fold training minimum derives from the gate (13 → 8). The `/enroll` wizard reads gates from the generated `FEATURE_SPEC`.
  Regenerated `web/src/lib/contracts.ts`. Branch `ml-wider-gap-13wf`.
- 2026-09-26 18:30 ET · Claude · semantics · temporal `close.train_every_nth: 6` now defines the non-overlapping unit that the
  temporal gate and evaluations count. The model's default detector v2 fits and calibrates on every window. Its 60 s fold purge
  exceeds the 30 s window, so references never overlap their training windows. No wire, DB or name change.
