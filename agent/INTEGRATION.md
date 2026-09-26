# Codex 1 integration handoff

## Owned deliverables

- `agent/twobme_agent`: capture, doctor, local recorder, pair/Keychain, live runtime, Unix marker socket, WebSocket + HTTPS + SQLite transport, time calibration and replay.
- `packages/features`: five feature modalities, evidence closure, resampled mouse kinematics, workflow categories and temporal Welch/ACF.
- `packages/ml`: enrollment filtering and gates, purged OOF ensemble typicality, artifact versioning, exact numerical trust contract, ROC/EER/ablation/identification/live-trial evaluation and bounded manual retraining.
- `web/src/sdk/presence.ts`: counts-only, reference-counted presence listener; no P1 browser behavioral scoring.
- `web/src/app/enroll`: responsive four-stage wizard; imports Codex 2's `VoiceEnroll` and calls shared REST/WS interfaces.
- `contracts/key_classes.json`, `contracts/app_categories.json`, synthetic events and expected feature fixtures.

## Exact integration requirements

1. Install shared `twobme_common.types` DTOs described in §5.6. Signals accepts a canonical YAML mapping or a FeatureSpec exposing `names(modality)`.
2. `TrustEngine(cfg)` accepts the published `TrustConfig` object, canonical nested YAML mapping, or the flat isolated-test mapping. `TrustEngine()` reads `contracts/trust_config.yaml`. Beta is never read from model artifacts. The hub chooses initial enrollment/monitor anchors, applies restore staleness, suppresses evidence in learning/locked states, persists `to_dict()` and owns challenge/lock/policy actions. Numerical engine does not make authorization decisions.
3. `UserModel.train(df, cfg)` accepts the core's `TrustConfig` (loads canonical feature spec) or an explicit `{'spec': spec, 'schema_version': 1, ...}` mapping. Datetime columns must be timezone-aware. `features` may be vectors in canonical order or named dictionaries. Nulls are imputed inside each calibration fold. Workflow matrix estimation is fold-local. Temporal context is sampled every sixth row per session.
4. Enrollment provenance: baseline eligible or enroll mode, owner actor, no impostor label. Updates require eligible candidates older than ten minutes plus explicit takeover/reset/session exclusions. Unknown DB provenance fails closed. Raw local log actors/labels supply initial enrollment provenance.
5. `twobme_ml.update.retrain(current, training, anchor_holdout, impostor_holdout, candidates, cfg)` is the manual retrain entry point. `training.is_anchor` must protect ≥30%; at most 10% replacements; regressions reject; new artifact retains `parent_version`. `CONTINUOUS_UPDATE=false` disables it.
6. Wire fallback currently POSTs `{'ticks':[tick]}` to `/api/agent/ticks`; 2xx means durably accepted/deduplicated. See `contracts/REQUESTS.md` for acknowledgement and status-field additions.
7. Global authenticated web layout should mount the presence singleton. Enrollment currently mounts it too; reference counting prevents duplicate listeners. Other frontend pages/styles and core API clients remain untouched.
8. Enrollment depends on default export `web/src/components/voice/VoiceEnroll.tsx`; voice/TOTP behavior remains Codex 2's responsibility. Live snapshots must include device, enrollment and model data from §5.2. Gates are server-authoritative for training readiness.

## Current verification limits

- Published core `524d1e8` is now merged into this branch. Canonical DTOs/spec, workspace packages, trust configuration adapter, and actual ModelManager artifact loading have been checked. No running website activation or deployment was performed.
- Live native capture was confirmed over 60 seconds: 192 key-down/up pairs, 1,045 moves, 23 clicks and 260 scroll events; zero drops. A separate Terminal.app launch and stage lock/unlock flow remain unverified.
- Tests use isolated test DTOs only when common does not exist. UI verification uses a temporary React harness with fake backend/voice dependencies, not a deployed app.
- Fixed-seed exact-default Monte Carlo: 97.168% genuine ticks ≥.90; 84.5% runs without proactive arming (target ≥85%; one run short); median impostor arming 50s from cap and 40s from .97. This acceptance assertion remains red pending review.
- Three A recordings and one B recording now support real model training. `reports/eval.json` contains primary global-split metrics: mouse AUC .549/EER .481, scroll .635/.371, offline combined .784/.375. A separate fixed 100-block keyboard-prefix test gives .836/.217 on 23 future A blocks and 62 B blocks. The selected candidate enables keyboard and scroll. B was used for selection; fresh final validation and all five live takeover trials remain pending. Synthetic results remain separate.
- P1 SDK parity, click/drag game, automatic updates, splice/tuning sweep are deferred per §0.2. No deployment or main push has occurred.
