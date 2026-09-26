# STATUS log (humans + agents append; newest at the bottom)

Format: `- HH:MM ET · <who> · <what> · <next / blockers>`

## Sat Sep 26
- 00:49 · Claude · started A0 in worktree `.claude/worktrees/ws-core` (branch `ws-core`).
- 01:40 · Claude · **CP0 ready**: contracts (feature_spec v1: 80 features / 15 headline; trust_config v1; messages/api/event_log),
  `twobme_common` (types/spec/config) + 15 contract tests, `contracts.ts` + report JSON Schemas generated, voice STUB,
  FastAPI skeleton (hub, WS, auth, decisions, presence, TOTP, demo, history, Tiger writer) with 14 §11.2 invariant tests,
  Tiger migrations 001–004 verified on local TimescaleDB 2.30.1 (15-min columnstore jobs, 3 real-time caggs),
  `gate.sh` + `check_privacy.sh`. Seeded `ops/queue_codex{1,2}.md` with CP0 interface notes — **Codex 1/2: read them**.
  Next: web scaffold (in progress), deploy skeleton for CP1. Needs humans: VM/DNS/Caddy step 0, Tiger URL, `.env`.
- 01:45 · Claude · **CP0 tagged** `cp0-contracts` on main (d884464). Codex 1/2: branch from / merge `main` now.
- 01:55 · Claude · A4 deploy files ready (Dockerfile.base/api, compose, Caddyfile validated with caddy 2.11.4, deploy.sh,
  step-0 compose + /mictest). API image builds and boots against TimescaleDB. `scripts/core_e2e_local.sh` passes 20/20
  (enroll → train from Tiger → takeover → proactive challenge → C → BLOCK_IMPOSTOR → lock → unlock VERIFY → co-present Y).
  **Humans (B), step 0:** VM `vhp-8c-16gb-amd` ewr (Docker image), firewall 22/80/443tcp/443udp, DNS A @/www/app/api,
  then on the VM: `git clone` + `docker compose -f infra/docker-compose.step0.yml up -d` → https://2bme.tech/mictest.
  Then fill `.env` (Tiger URL, SESSION_SECRET, ADMIN_TOKEN, seed passwords) and run `infra/deploy.sh`.
  Needs a decision: push `main` to origin (VM deploys via git pull).
- 02:40 · Claude · Real-backend check in headless Chrome (uvicorn + TimescaleDB + synthetic agent): dashboard live, takeover →
  1% with TTD 11 s + proactive challenge banner; /shop Pay → C (remote, 0.30); /verify stub VERIFY → own order Y, a
  different web session's order N. Fixed: FFT panel (log10 PSD), why-chips (red only when against owner), feed duplicates,
  reload loses block history (`Snapshot.recent_blocks`). main fast-forwarded. **Codex 1: no ws-signals branch yet.**
- 13:45 · Claude · **A2 confirmed** on real Tiger Cloud: `server/tests/test_history_tiger.py` (`TEST_TIGER_URL`) green —
  migrations 001–005 apply idempotently, hypertables/caggs present, `/tiger/stats` shows `policy_compression` every
  15 min, history endpoints round-trip, `/enroll/train?source=tiger` reaches `ready`. Queue A2 checked off. Next: item 4
  (walking skeleton deploy) still needs VM/DNS/Caddy step 0 + real `TIGER_DATABASE_URL`/secrets in the VM `.env` (never
  committed) before `infra/deploy.sh`.
- 14:35 · Claude · **User decision: Electron on-laptop overlay** (kept the site). `overlay/` (Electron 44 shell) + `/overlay` page:
  pill (live trust) → full-screen voice check when a challenge arms (snoozable; behavior alone never blocks) → lock screen on
  BLOCK_* → owner signs in + voice unlock → pill. Verified against the real backend (headless for full-screen modes; the
  Electron pill ran on the dev Mac). BLOCK_* now also closes the revoked user's /ws/live sockets. IMPLEMENTATION.md §6 A6 added.
- 14:42 · Claude (main checkout) · merged `ws-core` → `main` (cfdb2e8): re-ran the merge gate myself (not just taking the
  ws-core session's word) — `check_privacy.sh` ok, `gate.sh core` all green (contracts/server/web/overlay), then
  `core_e2e_local.sh` 20/20. Reviewed `overlay/src/main.ts`/`preload.ts` for the privacy boundary: sandboxed, no Node
  integration, no input capture, mic permission scoped to same-origin only — clean. Not pushed to origin yet.

## 2026-09-26 — Codex 2 — ws-voice — C0 local foundations

- Read IMPLEMENTATION §0–§5 and §8 and AGENTS.md. Created isolated worktree
  `.worktrees/ws-voice` on branch `ws-voice`, based on `305baa3`.
- Implemented `packages/hearsay`: Python 3.12 package and extras, native audio
  decoding plus anti-aliased 16 kHz mono conversion, bounded in-memory WebM/Opus
  fallback, deterministic CM windows, 300-word vocabulary, secure five-word
  phrases, aligned phrase checks, reference-compatible DET/EER/minDCF,
  20-per-class score-direction smoke utility, template-preserving atomic TSV
  writer and CLI. Official rules remain configurable and unconfirmed.
- Verification: **41 tests passed**, including a real ffmpeg WebM/Opus roundtrip
  and high-frequency alias rejection. Ruff lint and format checks passed.
  `git diff --check` passed. No recorded or generated audio was added to git.
- Official ASVspoof5 parity: **203 cases × 2 cost settings passed** at absolute
  tolerance 1e-14, including ties, perfect ordering and inversion. Reference:
  `asvspoof-challenge/asvspoof5/main/evaluation-package/calculate_modules.py`,
  SHA256 `1118b9e0bc045f22196b249d950fc50efd0af741bd0488b0164f8a23d1d39e3c`.
  Reproduce with `scripts/voice_check_metrics.py --reference <downloaded-source>`.
- A real fallback test exposed ffmpeg builds without optional libsoxr. Fixed by
  decoding native-rate PCM through an in-memory WAV, then using Python soxr HQ.
- Created submission README, honest pending runtime/rules checklists, and the
  initial `ops/queue_codex2.md`. Logged dependencies and contract ambiguities in
  `contracts/REQUESTS.md` (rank offset, 64-vs-84 spectral vector, spoof precedence).
- **Next:** batch-box model smoke and actual inference; official materials for
  safety TSV; CP0 DTO/stub handoff for server and web integration. No model
  weights or torch downloaded locally. No fabricated metrics, predictions or
  model-performance claims.
- **Merge gate pending:** `scripts/gate.sh` and core e2e/privacy scripts do not
  yet exist on this worktree's base. Full C0 model smoke and C1/C2 remain open.
  Nothing pushed, deployed, or submitted; main untouched.

## 2026-09-26 — Codex 2 — C0 adapters, C1 runner, C2 primitives

- Added lazy DF_Arena/fallback detector adapters with explicit full model SHAs,
  correct opposing logit indices, serialized CM inference, CPU thread settings
  and CUDA autocast. Added ECAPA tensor adapter, normalized 192-dimensional
  embeddings, max-over-centroids matching and Silero adapter.
- Added speech preparation with overlap-safe 150 ms padding, net speech duration
  and close-talker onset. DSP computes required FFT/mel/MFCC summaries, F0 and
  spectrogram; mismatched profile dimensions are rejected.
- Added `hearsay predict`: frozen-template order, atomic final TSV, append/fsync
  checkpoints every 50 attempts, exception recovery, exclusive writer lock,
  model/corpus metadata matching, and repeated input checks before output.
  Only decoding failures become unreadable; model errors halt. No audio hashes,
  audio content or test-set fitting. CPU multi-worker tuning remains pending.
- Added pure decision rules with required explicit calibration: spoof beats
  RETRY, silence retries, unlock gray zone retries, third retry becomes MFA,
  missing/invalid evidence never verifies. No server or trust side effects.
- Added runnable `voice_model_smoke.py` harness for silence, two warmups, both
  detector profiles, 20+20 direction check and median/p95 stage timings.
- **Validation:** 98 package tests passed, lint/format passed, CLI help for
  prediction and smoke passed without torch. Includes real ffmpeg decoding and
  synthetic signal tests, model adapters/harness tested with fakes. Actual
  model-loading APIs, calibration, clone detection and VM latency remain pending.
  Wheel built offline and inspected for required modules/data and absence of audio.
  End-to-end prediction CLI tested on temporary synthetic WAVs with a fake model,
  including a complete-journal resume that performs no model load.
- **Dependencies unchanged:** CP0 is still uncommitted in ws-core; no handoff
  tag, batch SSH target or official Hearsay materials available. No server/web
  files edited and no new cross-package DTOs defined. Full merge gate still
  unavailable on this branch. No push, deploy or official submission.

## 2026-09-26 — Codex 2 — CP0 integration and C3 browser flow

- Merged the published `cp0-contracts` tag into `ws-voice` (`7a80af0`), preserving
  both streams' status, queue and request notes. Earlier CP0 blockers are now
  historical. The backend remains the CP0 stub; real C2 integration is pending.
- Built native-rate mono PCM16 AudioWorklet capture (exactly six seconds), pinned
  microphone selection, explicit start gesture, prompt-ended acknowledgement,
  beep/countdown, manual playback fallback, live FFT and stream cleanup on
  cancellation, disconnection, error or unmount. Prompt samples are discarded.
- Added shared five-phrase voice enrollment, challenge retries, current-attempt
  stage feedback, response spectrogram and TOTP fallback. Takes stay in browser
  memory until upload, with no audio browser storage.
- Replaced `/verify` and `/shop` placeholders. Checkout shows the mandatory demo
  disclaimer, fixed test PAN, heartbeat/binding and policy matrix. It only
  resolves the matching pending order from server outcomes; final declines stay
  final. Polling recovers order expiry/completion with the dialog closed.
- **Validation:** `scripts/gate.sh voice` PASSED: 15 contract, 98 Hearsay,
  14 server and 32 web tests; privacy scan, generated contracts and TypeScript
  checks passed. Gate explicitly SKIPPED e2e because the CP0 base lacks
  `scripts/core_e2e_local.sh`. Production static build passed after clearing a
  cached sandbox port-binding failure. Browser inspection confirmed `/shop` and
  `/verify` render; API was offline during that visual check.
- New tests execute the actual worklet at 44.1/48 kHz with synthetic samples,
  verify prompt exclusion/WAV duration/cancellation, delayed-permission cleanup,
  wrong-device cleanup, and order binding. No physical-mic or real-model success
  is claimed. Runtime used Python 3.12 and local Node 24.
- **Remaining:** batch box and official materials; calibrated C2 backend;
  hardware/browser capture checks; enrolled-LTAS DTO and 64-vs-84 profile
  resolution. Requested web mic-label wiring and core lock regeneration. Gate's
  generated `uv.lock` change was restored, because Claude owns it.
- Requesting Claude's merge review of the local `ws-voice` commits after the
  passing gate, with the above limitations. Nothing pushed or deployed.

## Sat Sep 26 (cont.)
- 16:05 · Claude · **Merged `ws-voice` → `ws-core` → `main`** (34bd857, ffbad5b; not pushed). Took Codex 2's `/shop`
  and `/verify` wholesale (the planned A0-stub-to-C3 handoff); combined REQUESTS.md/STATUS.md/queue_codex2.md
  chronologically. Regenerated `uv.lock` for `packages/hearsay`'s deps. Gate: privacy, contracts, 98 hearsay tests,
  server, web typecheck/tests, overlay, e2e 20/20 all PASS (`voice_test.sh`'s own check fails only because this
  machine has no bare `python3.12` on PATH; ran its pytest/ruff steps directly against `.venv/bin/python3.12` — clean).
- 16:03 · Claude · Rewired the overlay's full-screen voice check onto Codex 2's real `voice/challenge-flow.tsx`
  (e59b0da) — no `onDone` needed, overlay mode is driven by live server state. Kept `verify-stub`/`mockBackend` for
  `?mock=1` only, since the real component has no mock path; deleted `shop-stub/` (fully dead). Gate green (core).
- 16:05 · Claude · **Drafted IMPLEMENTATION.md §2.4** (95c17bf, PROPOSED, not yet pinged to Codex 1/2): per
  `newGoal.txt`, the overlay is the product for the enrolled individual; the `.tech` site becomes an admin/org
  panel (synthetic multi-employee roster, org-wide anomaly detection, audit trail) instead of a second consumer
  app. Scoped as P1 given the Sun 08:00 ET hard stop — reuses `/dashboard` as the per-employee drill-in, adds one
  new roster page fed by synthetic data, leaves `/shop`/`/verify`/`/enroll` untouched. Doesn't change §4 ownership.
- 16:12 · Claude · **Shipped a first pass of `/admin`** (b197c67, 16bf896): ~20 synthetic anonymized employee
  sessions (trust score, team, device, last alert), an org-wide audit trail, admin-role gated, click a card to
  drill into that session's trust gauge / modality bars / why-chips / event feed (reused directly from
  `components/dashboard/`, no rebuild). All data is fabricated client-side in `lib/admin-mock.ts` — no new
  backend endpoints. Verified with tsc, vitest, a static export build and a headless-Chrome screenshot of the
  rendered page. Gate green (core). §2.4 direction is still PROPOSED — needs sign-off and a ping to Codex 1/2
  before this is anything more than a Workstream-A draft.
