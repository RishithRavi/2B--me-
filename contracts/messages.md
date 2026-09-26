# WebSocket protocol v1 (§5.2)

Source of truth for shapes: `packages/common/src/twobme_common/types.py` (TS: `web/src/lib/contracts.ts`).
Examples: `contracts/fixtures/ticks/{hello_example,tick_example,block_*}.json`.

## Time
- Every wire and DB timestamp is UTC ISO-8601 with **milliseconds** and `Z`: `2026-09-26T14:30:05.000Z`.
- Agent intervals come from calibrated CGEvent monotonic ns. Wall time = `mono + (time_ns − monotonic_ns at start) + offset`,
  sent already corrected; the server never corrects again.
- Clock offset: `clock_ping {t0_ns}` → `clock_pong {t0_ns, server_ns}`; agent keeps the lowest-RTT of its last 8, repeats every 60 s.
- Skew: for a non-late tick with `|t_end − now| ≥ 30 s`, the server substitutes receive time and sets `flags.clock_skew`.
- Replay uses current wall time. `--speed > 1` only for ingest/eval, never live-trust demos.

## Agent → `wss://2bme.tech/ws/agent`
`hello` must be the first frame (otherwise the server closes with 4401). Agent→server models are **strict**
(`extra="forbid"`): unknown fields are rejected — this is part of the privacy boundary.

| type | model | notes |
|---|---|---|
| `hello` | `Hello` | `device_token`, `run_id` (uuid4 per process), `resume_session_id`, `requested_mode`, `agent_version`, `schema_version`, `os`, `pointer`, `display{w_pt,h_pt,hz}`, `last_unlock_at` |
| `tick` | `Tick` | every 5 s: `run_id, session_id, seq, t_end, flags, counts, activity[5], blocks[], context` |
| `marker` | `MarkerMsg` | `label: takeover_start|takeover_end|note`, `t` (⌃⌥⌘M toggles start/end) |
| `os_event` | `OsEventMsg` | `event: screen_locked|screen_unlocked|sleep|wake`, `t` |
| `demo` | `DemoMsg` | `action: reset` (⌃⌥⌘R, expo mode) |
| `clock_ping` | `ClockPing` | `t0_ns` |

`Block.features` carries **exactly** `spec.names(modality)` (null = insufficient evidence). `wf.markov_ll` is always
null on the wire (`derived: model`). Workflow blocks add `transitions {"ide>browser": 2}` (categories only);
the temporal context adds `psd: float[32]`.

`activity` = input events per 1 s bucket over the tick (sparkline + co-presence); not stored.
`counts` goes to `trust_ticks.flags`.

**Idempotency / sessions**
- Dedupe on `(device_id, run_id, seq)`; `seq` restarts at 0 per run. Tiger inserts `ON CONFLICT DO NOTHING`.
- Late ticks (`flags.late`) are stored under their own `session_id`; blocks with `t_end < now − 60 s` are stored only, never scored.
- A `hello` with `resume_session_id` whose session was seen < 10 min ago reuses it; otherwise a new session starts.
- HTTPS fallback while the WS is down: `POST /api/agent/ticks {ticks:[Tick]}` with `Authorization: Bearer <device_token>`.

## Server → agent
| type | model | fields |
|---|---|---|
| `welcome` | `Welcome` | `device_id, user_id, session_id, mode, model_version|null, label, actor` |
| `trust` | `AgentTrust` | `seq|null, confidence, display, level, locked, per_modality{m:{llr,delta}}` |
| `challenge` | `AgentChallenge` | `challenge_id, trigger, verify_url, expires_at` → osascript notification; `open verify_url` only if no bound browser had `/ws/live` in the last 15 s |
| `lock` / `unlock` | `AgentLock` / `AgentUnlock` | `{reason}` / `{}` |
| `mode` | `AgentMode` | `{mode}` |
| `clock_pong` | `ClockPong` | `t0_ns, server_ns` |
| `error` | `AgentError` | `code, detail` (e.g. `bad_tick`, `schema_version`) — the connection stays open |

Close codes: `4401` bad/missing token or no hello, `4409` superseded by a newer connection for the same device.

## Server → `wss://2bme.tech/ws/live` (cookie auth)
A user sees their own devices; admin (observer) sees all. Envelope: `{"type","device_id","t","data"}` (`LiveEvent` in TS).

| type | data |
|---|---|
| `snapshot` | `Snapshot` — sent on connect and after `/demo/reset`: device, session_id, label, actor, trust, trust_history (10 min), markers (10 min), model, enroll, open_challenge, recent_events (≤50), last_tick_json, health, enrolled_psd |
| `trust` | `TrustLive` = TrustState + `seq`, `locked` |
| `block_scored` | `BlockScored` `{modality, t_start, t_end, n, typicality, llr, q, delta, top:[{feature,label,unit,z}]}` |
| `context` | `ContextLive` `{psd, features, enrolled_psd}` (FFT panel) |
| `enroll_progress` | `EnrollProgress` `{mode, counts{m}, gates{m}, ready}` |
| `model` | `ModelInfo` |
| `anomaly` | `AnomalyLive` — re-sent with the same `id` when the explanation arrives |
| `challenge` | `ChallengeLive` `{challenge_id, trigger, status, attempt, expires_at, verify_url}` |
| `voice_stage` | `VoiceStageLive` `{challenge_id, stage, ok, value}` (transcribing → anti-spoof → speaker → spectral) |
| `voice_result` | `VoiceResultLive` (VoiceResult without spectrogram + challenge_id) |
| `decision` | `DecisionLive` (DecisionOut + action, amount_cents) |
| `marker` | `MarkerPoint` `{t, label, text}` |
| `mode` / `lock` / `unlock` / `label` | `{mode}` / `{reason}` / `{}` / `{label, actor}` |
| `presence` | `PresenceLive` `{binding: co-present|remote, score}` |
| `health` | `HealthLive` (heartbeat age, tap events/s, secure_input, last block age per modality, rtt, voice_warm, quota, activity) |
| `feed` | `FeedItem` `{t, type, text, severity}` — human-readable event-feed line |

Markers are ground truth for the TTD stopwatch and eval only; they **never** reach the scorer or TrustEngine.
