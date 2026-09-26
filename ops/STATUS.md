# STATUS log (humans + agents append; newest at the bottom)

Format: `- HH:MM ET · <who> · <what> · <next / blockers>`

## Sat Sep 26
- 00:49 · Claude · started A0 in worktree `.claude/worktrees/ws-core` (branch `ws-core`).
- 02:25 · Claude · **CP0 ready**: contracts (feature_spec v1: 80 features / 15 headline; trust_config v1; messages/api/event_log),
  `twobme_common` (types/spec/config) + 15 contract tests, `contracts.ts` + report JSON Schemas generated, voice STUB,
  FastAPI skeleton (hub, WS, auth, decisions, presence, TOTP, demo, history, Tiger writer) with 14 §11.2 invariant tests,
  Tiger migrations 001–004 verified on local TimescaleDB 2.30.1 (15-min columnstore jobs, 3 real-time caggs),
  `gate.sh` + `check_privacy.sh`. Seeded `ops/queue_codex{1,2}.md` with CP0 interface notes — **Codex 1/2: read them**.
  Next: web scaffold (in progress), deploy skeleton for CP1. Needs humans: VM/DNS/Caddy step 0, Tiger URL, `.env`.

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
