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
- 03:10 · Claude · **User decision: Electron on-laptop overlay** (kept the site). `overlay/` (Electron 44 shell) + `/overlay` page:
  pill (live trust) → full-screen voice check when a challenge arms (snoozable; behavior alone never blocks) → lock screen on
  BLOCK_* → owner signs in + voice unlock → pill. Verified against the real backend (headless for full-screen modes; the
  Electron pill ran on the dev Mac). BLOCK_* now also closes the revoked user's /ws/live sockets. IMPLEMENTATION.md §6 A6 added.
