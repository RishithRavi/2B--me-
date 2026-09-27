# REST API v1 (§5.3)

Everything under `/api`; WebSockets under `/ws`. `api.2bme.tech` is an alias with the identical path space.
Users: signed httpOnly `SameSite=Lax` cookie `twobme_session`. Agent: `Authorization: Bearer <device_token>`.
Admin endpoints: an admin cookie session **or** `X-Admin-Token: $ADMIN_TOKEN`.
Shapes: `twobme_common.types` (TS `contracts.ts`). Errors: `{"detail": "..."}` with 4xx/5xx.

## Auth
| method | path | body → response |
|---|---|---|
| POST | `/auth/login` | `LoginIn{email,password}` → `MeOut` + sets cookie. **Never changes device trust.** |
| POST | `/auth/logout` | → `OkOut` |
| GET | `/me` | → `MeOut{user_id,email,handle,role,totp_enrolled,device}` |

Seeded accounts: `a@2bme.tech`, `b@2bme.tech`, `admin@2bme.tech` (role `admin` = observer; never revoked, never anchors trust).

## Devices and agent
| POST | `/devices/register` (cookie) | `DeviceRegisterIn` → `DeviceRegisterOut{device_id, device_token}`. A user's first device starts in enroll mode (0.97 after training activation); a new device of a user who already has an active model starts in **monitor at 0.30** (§5.3, §5.4) |
|---|---|---|
| GET | `/devices` (cookie) | → `DeviceOut[]` |
| POST | `/agent/ticks` (Bearer) | `AgentTicksIn{ticks}` → `AgentTicksOut{accepted, duplicates}` (HTTPS fallback) |

**Binding:** a web session binds to the cookie user's most recently seen device. `/pair` is P2.

## Presence (P0)
| POST | `/web/presence` | `PresenceIn{buckets:[{t_s,keys,pointer,wheel}]}` every 2 s → `PresenceOut{binding, score, device_id}` |
|---|---|---|

co-present ⇔ over the last 20 s at some lag ∈ {−1,0,+1} s: `pearson(browser, agent activity) ≥ 0.5` over ≥ 5 browser-active
seconds **and** agent count ≥ 0.8 × browser count in ≥ 80% of browser-active seconds. Otherwise **remote** (0.30).

## Enroll and models
| POST | `/enroll/mode` | `EnrollModeIn{device_id, mode}` → `OkOut`. `mode=enroll` is **admin-only** (403) once the user has an active model; agent `hello.requested_mode=enroll` is ignored for such a user (feed line) |
|---|---|---|
| GET | `/enroll/status?device_id=` | → `EnrollProgress` |
| POST | `/enroll/train` | `EnrollTrainIn{device_id, source: tiger|logs}` → `JobOut{job_id}`; then a `model` live event |
| POST | `/models/retrain` | `RetrainIn{device_id}` → `JobOut` (Retrain now) |
| GET | `/models/active?user_id=` | → `ModelInfo` |
| GET | `/models/history?user_id=` | → `ModelInfo[]` |

## Decisions (policy §5.4)
| POST | `/decisions` | `DecisionIn{action, amount_cents?}` → `DecisionOut` |
|---|---|---|
| POST | `/checkout/authorize` | `CheckoutIn{amount_cents, card_last4}` → `DecisionOut` |
| GET | `/decisions/{id}` | → `DecisionDetailOut` (+ `final_decision, final_trans_status, resolved_at`) |

`DecisionOut{decision_id, status: final|pending, decision: allow|step_up|block, trans_status: Y|C|N, confidence, tier, binding, reasons[], challenge_id, verify_url}`.

## Voice (Codex 2, `server/app/voice`, mounted at `/api/voice`)
| POST | `/voice/enroll/start` | → `VoiceEnrollStartOut{enroll_id, phrases[5]}` |
|---|---|---|
| POST | `/voice/enroll` | multipart `enroll_id`, `wav`×5 → `VoiceEnrollOut{enrolled, n_utts, intra_cos}` |
| POST | `/voice/challenges` | `ChallengeCreateIn{reason: unlock|redteam|sandbox}` → `ChallengeOut` (server issues proactive/step_up itself) |
| GET | `/voice/challenges/{id}` | → `ChallengeOut` |
| GET | `/voice/challenges/{id}/prompt.mp3` | audio; first GET starts the 30 s TTL, capped at `issued_at + 120 s` |
| POST | `/voice/challenges/{id}/prompt-ended` | → `OkOut`; status → `prompt_ended` |
| POST | `/voice/challenges/{id}/response` | multipart `wav`, `client_prompt_end_ms` → `ChallengeResponseOut{result, outcome, next?}` |
| POST | `/voice/totp/verify` | `TotpVerifyIn{challenge_id, code}` → `TotpVerifyOut{ok, outcome}` |
| POST | `/voice/totp/enroll` | → `TotpEnrollOut{otpauth_uri}`. **409** when a secret already exists, unless the caller is admin or the bound device had a voice/TOTP VERIFY in the last 5 min (§5.3; enforced in `app.core.totp`) |

Stub voice (`VOICE_MODE=stub`, demo only; Sat 20:20): the response endpoint returns a canned `VoiceResult` chosen by
`X-Fake-Decision: VERIFY|RETRY|FALLBACK_MFA|BLOCK_SPOOF|BLOCK_IMPOSTOR`. The header is honoured **only from an admin** (admin
cookie or `X-Admin-Token`); a user-sent header is stripped. Otherwise `VoiceDemoMiddleware` injects the operator override from
`/demo/voice-outcome`, or a label-aware default: BLOCK_IMPOSTOR while the device is labelled impostor (Mark takeover), else
VERIFY; unlock challenges ignore BLOCK_*/RETRY overrides. An override clears on `/demo/reset` and after a BLOCK_* it produced has
locked the device. Every stub result is published with `VoiceResultLive.simulated=true`. Real mode rejects fake headers (400).
An unlock challenge on an **admin-locked** device returns 409 (only an admin unlocks it).

## History (Tiger)
| GET | `/history/sessions?limit=` | → `SessionRow[]` |
|---|---|---|
| GET | `/history/trust?session_id=&from=&to=&bucket=` | → `TrustSeries` (gap-filled) |
| GET | `/history/anomalies?limit=` | → `AnomalyRow[]` |
| GET | `/history/baseline?modality=&session_id=` | → `BaselineOut` (session medians vs enrollment baseline) |
| GET | `/history/drift` | → `DriftRow[]` (P1) |
| GET | `/tiger/stats` | → `TigerStats` |

## Reports
| GET | `/eval/report?kind=eval|redteam|hearsay` | served from `reports/*.json` (sample fallback: `contracts/fixtures/reports/`) |
|---|---|---|

## Demo and admin (`DEMO_MODE=1`)
| POST | `/demo/label` | `DemoLabelIn{device_id, label, actor}` |
|---|---|---|
| POST | `/demo/marker` | `DemoMarkerIn{device_id, label, text?}` |
| POST | `/demo/reset` (admin) | `DemoDeviceIn` — cancel challenges, clear lock, new session, label genuine/a, L = logit(0.97) reason `operator_reset`, push `snapshot`; < 1 s |
| POST | `/demo/rearm` (admin) | `DemoRearmIn{device_id, confidence=0.31}` — L = logit(conf), `rearm` marker |
| POST | `/tiger/compress-now` (admin) | compress `feature_blocks` chunks older than 1 h |
| GET | `/demo/redteam/active-challenge?device_id=` (admin) | → `RedteamActiveOut | null`; every read logs an anomaly `redteam_tool` |
| POST | `/demo/purge-session` (admin) | `PurgeSessionIn{session_id}` |
| POST | `/demo/voice-outcome` (admin) | `DemoVoiceOutcomeIn{device_id, decision|null}` — **stub voice only**: sticky operator-chosen outcome for this device's challenge responses until cleared; every result it produces is `simulated=true`. 409 in real voice mode |
| POST | `/demo/org/seed` (admin) | `OrgSeedIn{n=19}` → `OrgSeedOut{employees[{user_id, handle, team, device_id, device_token}]}` — idempotent pseudonymous org-demo users `emp01@org.2bme.tech`… (`handle` "Employee 01", `team`), one monitor-mode device each; re-seeding rotates tokens. Driven by `scripts/core_org_demo.py` |

## Admin / org panel (§2.4; admin cookie or `X-Admin-Token`)
| GET | `/admin/roster` | → `RosterRow[]` — every device: hub trust (level, confidence, display), online (heartbeat < 30 s), lock, open challenge, model version/backend, last anomaly, 5-min sparkline, flags; A's real device first, then by severity |
|---|---|---|
| GET | `/admin/audit?limit=100&device_id=` | → `AuditRow[]` newest first — trust-level changes, alerts (anomalies), challenges, decisions, locks, markers, model versions and admin actions. Tiger `audit_log` when up, in-memory ring otherwise |
| POST | `/admin/actions` | `AdminActionIn{device_id, action: lock|unlock|force_reverify|ack_alert|note, anomaly_id?, text?≤80}` → `AuditRow`. `lock` = admin lock (reason `admin_lock`, L pinned); `unlock` clears an admin lock only (voice/BLOCK locks still need a VERIFY, §5.4); `force_reverify` issues a proactive challenge; `ack_alert` sets the anomaly's resolution; every action is audited with the admin's handle |
| WS | `/ws/live?scope=org` | admin only: no device filter and no snapshot on open; every device's events plus `audit` rows as they happen |

## Health
| GET | `/healthz` | 200 `{ok:true}` only after the voice warm-up; 503 otherwise |
|---|---|---|
| GET | `/status` | → `StatusOut` (tiger up/down, voice_warm, writer stats, quota, `voice_mode` stub/real, `model_backend`, …) |

## Browser SDK (P1)
| POST | `/web/blocks` | `{blocks: Block[]}` — counted only when the bound device has no fresh agent heartbeat |
|---|---|---|
