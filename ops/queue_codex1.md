# Queue — Codex 1 (Workstream B: signals and models)

Seeded by Claude from IMPLEMENTATION.md §7 at CP0; humans may reorder. Branch `ws-signals`.
If blocked → `contracts/REQUESTS.md` → next item.

1. B0 probe → `agent/PROBE.md` (≤ 30 min)
2. B0.5 recorder on A's laptop by 01:45; `key_classes.json` + `app_categories.json` first (you own them in `contracts/`)
3. B2 features per `contracts/feature_spec.yaml` (names/order from the yaml ONLY; `twobme_common.spec.load_spec()`)
4. B3 `twobme-ml train --from-logs` → `data/eval/night.json` (CP1 deliverable)
5. `scripts/sig_make_fixtures.py` → `contracts/fixtures/events/{genuine_A,impostor_B}.jsonl` + `fixtures/expected/*` by CP1
6. B1 agent live (`run`, `replay`, hotkeys, HTTPS fallback) → B4 TrustEngine → /enroll page
7. B5-min `reports/eval.json` (schema: `contracts/schemas/eval.schema.json`), B7-min, presence.ts

## CP0 interface notes from Claude (read before B1/B3/B4)
- **Server imports** (see `server/app/core/models.py`, `hub.py`):
  - `from twobme_ml import UserModel`: `UserModel.train(df, cfg) -> model`, `model.save(dir)`, `UserModel.load(dir)`,
    `model.score_block(Block) -> BlockScore | None`, and a settable `model.version` attribute.
    Optional `UserModel.retrain(parent_model, df, cfg)` for B7 (server calls it for "Retrain now" if present).
    `cfg` is `twobme_common.config.load_trust_config()` (TrustConfig). The server passes `df` with columns
    `time, block_start, session_id, modality, n, features (list, spec order), extras, label, actor, schema_version,
    baseline_eligible, update_candidate` (rows already filtered: no actor b / impostor / reset / sandbox sessions).
  - `save(dir)` should write `meta.json` with `n_blocks{m}`, `enabled_modalities[]`, `metrics{}`,
    `headline_medians{column}`, optionally `learned_since_enroll`, `enrolled_psd[32]`. The server fills any that are missing.
  - `from twobme_ml.trust import TrustEngine`: constructor `TrustEngine(cfg)` or `TrustEngine()`, `on_tick(t_end, idle_s, scores) -> TrustState`,
    `anchor(p)`, `to_dict()`, `TrustEngine.from_dict(d)`. The hub pins L to the minimum while locked via `anchor(1 - cap)`,
    and never feeds markers to the engine. Reference implementation of §5.4: `server/app/core/trust_fallback.py`
    (use it as a cross-check; your tests are the source of truth).
- `wf.markov_ll` is in `names("workflow")` (`derived: model`): the agent sends null; UserModel computes it from `transitions`.
- Enrollment gates are in `feature_spec.yaml` (`enroll_gate`); n_ref too. `TrustConfig.n_ref` is merged from the spec.
- Agent WS: `hello` first; wire models are `extra="forbid"` (unknown fields rejected). Adopt `session_id` from **every**
  `welcome` (the server sends a new one after screen unlock and demo reset). `AgentChallenge.open_browser` tells you whether
  to run `open verify_url` (server knows if a bound browser had /ws/live in the last 15 s). Close codes 4401 auth, 4409 superseded.
- Presence: `POST /api/web/presence {buckets, client_now_ms: Date.now()}` (the server corrects browser clock offset).
- Test harness showing the exact flows: `server/tests/test_flows.py`.
