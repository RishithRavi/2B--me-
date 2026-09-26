# Queue — Claude (Workstream A)

Ordered. Done-criteria in brackets. If blocked → note in `contracts/REQUESTS.md` / `ops/STATUS.md` → next item.

1. [x] **A0 contracts → CP0** (tag `cp0-contracts`) [contracts/*, twobme_common + tests, contracts.ts, report schemas, voice stub, gate.sh, check_privacy.sh]
2. [ ] **A1 backend core** [hub/WS/auth/policy/decisions/presence/TOTP; §11.2 invariant tests green] — skeleton + 14 invariant tests done at CP0
3. [ ] **A2 Tiger** [migrations 001–004 applied on Tiger Cloud; writer; history queries; /tiger/stats shows 15-min columnstore jobs]
4. [~] **Walking skeleton deployed (CP1 06:30)** — deploy files + local e2e done; waiting on VM step 0 + push [https://2bme.tech: fixture replay → wss → dashboard → stub challenge → /verify uploads WAV → /shop Y/C/N]
   - needs humans: VM + DNS + Caddy/mictest (step 0), `.env` on the VM, Tiger URL, deploy key
5. [ ] **A3 core web P0 by CP2** [login, dashboard with all §6 A3 panels, `?stage=1`] — web agent building
6. [x] **core_e2e_local.sh** [§11.2 e2e: replay genuine_A then impostor_B → suspicious → proactive challenge → BLOCK_IMPOSTOR → lock → checkout N → unlock VERIFY → Y]
7. [ ] **Merge ws-signals / ws-voice** within 30 min of each request (gate must pass); regenerate uv.lock; add workspace deps to server
8. [ ] **A3 P0 by CP4**: landing, /history-min, /lab-min, status footer
9. [ ] **A5 P1**: Vultr explanations (template fallback done), drift_30m (cut first)
10. [x] **A6 overlay** (user decision 02:50): Electron shell + /overlay page; pill → prompt → lock → unlock verified headless
11. [ ] **CP4**: promote `trust_config.tuned.yaml` after review; VM snapshot

Rules: never deploy Sun 09:00–11:30; after any API restart run one `sandbox` challenge; `CONTINUOUS_UPDATE=false` + `TRAINING_FROZEN=1` from demo freeze.
