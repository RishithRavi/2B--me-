# Workstream status

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
