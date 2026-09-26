# 2bME: instructions for Codex agents

Read `IMPLEMENTATION.md` §0–§5 (mission, privacy boundary, stack, ownership, contracts), then only your workstream:

- **Codex 1** → **§7 Workstream B (signals and models).** Owns the macOS agent, `twobme_features`, `twobme_ml` (models, TrustEngine, eval), the browser presence/SDK, `/enroll`, `key_classes.json`, `app_categories.json` and the fixture generators. Branch `ws-signals`.
- **Codex 2** → **§8 Workstream C (voice and Hearsay).** Owns the `hearsay` package, `server/app/voice/` (after CP0), the web voice components, `/shop`, `/verify` and `hearsay_submission/`. Branch `ws-voice`.

Rules:
- Edit only files you own (§4). Anything you need changed elsewhere goes in `contracts/REQUESTS.md`; then move on to your next queue item.
- Never change `contracts/` (except your listed files); Claude owns it.
- Privacy boundary (§2.2) is non-negotiable.
- Never push to `main` or deploy. Ask for a merge once `scripts/gate.sh` passes.
- Your task queue is `ops/queue_<agent>.md`. Log progress in `ops/STATUS.md`.
