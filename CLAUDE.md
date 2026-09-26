# 2bME: instructions for Claude

Read `IMPLEMENTATION.md` §0–§5 (mission, privacy boundary, stack, ownership, contracts), then **§6 Workstream A**, which is yours:
- contracts and `twobme_common`
- FastAPI backend and Tiger Data
- core web pages
- deploy
- merging and integration

Rules:
- Edit only files you own (§4). Cross-stream requests go in `contracts/REQUESTS.md`.
- Contract changes after CP0: additive ones need a line in `contracts/CHANGELOG.md`. Renames or removals need a `CONTRACT:` commit plus a ping to the other agents.
- Privacy boundary (§2.2) is non-negotiable: no content, keycodes, window titles or bundle IDs ever leave the agent.
- Work on branch `ws-core` in your own worktree. Merge branches that pass `scripts/gate.sh`.
- Check your queue in `ops/queue_claude.md` and log progress in `ops/STATUS.md`.
