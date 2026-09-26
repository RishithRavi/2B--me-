# Queue — Claude (Workstream A)

Ordered. Done-criteria in brackets. If blocked → note in `contracts/REQUESTS.md` / `ops/STATUS.md` → next item.

1. [x] **A0 contracts → CP0** (tag `cp0-contracts`) [contracts/*, twobme_common + tests, contracts.ts, report schemas, voice stub, gate.sh, check_privacy.sh]
2. [ ] **A1 backend core** [hub/WS/auth/policy/decisions/presence/TOTP; §11.2 invariant tests green] — skeleton + 14 invariant tests done at CP0
3. [x] **A2 Tiger** [migrations 001–004 applied on Tiger Cloud; writer; history queries; /tiger/stats shows 15-min columnstore jobs] — `server/tests/test_history_tiger.py` green against real Tiger Cloud (`TEST_TIGER_URL`)
4. [~] **Walking skeleton deployed (CP1 06:30)** — deploy files + local e2e done; waiting on VM step 0 + push [https://2bme.tech: fixture replay → wss → dashboard → stub challenge → /verify uploads WAV → /shop Y/C/N]
   - needs humans: VM + DNS + Caddy/mictest (step 0), `.env` on the VM, Tiger URL, deploy key
5. [ ] **A3 core web P0 by CP2** [login, dashboard with all §6 A3 panels, `?stage=1`] — web agent building
6. [x] **core_e2e_local.sh** [§11.2 e2e: replay genuine_A then impostor_B → suspicious → proactive challenge → BLOCK_IMPOSTOR → lock → checkout N → unlock VERIFY → Y]
7. [ ] **Merge ws-signals / ws-voice** within 30 min of each request (gate must pass); regenerate uv.lock; add workspace deps to server
8. [ ] **A3 P0 by CP4**: landing, /history-min, /lab-min, status footer
9. [ ] **A5 P1**: Vultr explanations (template fallback done), drift_30m (cut first)
10. [x] **A6 overlay** (user decision 14:30): Electron shell + /overlay page; pill → prompt → lock → unlock verified headless
11. [ ] **CP4**: promote `trust_config.tuned.yaml` after review; VM snapshot

Rules: never deploy Sun 09:00–11:30; after any API restart run one `sandbox` challenge; `CONTINUOUS_UPDATE=false` + `TRAINING_FROZEN=1` from demo freeze.

## Re-baselined Sat 18:30 (audit; IMPLEMENTATION.md §0.3). Ordered; supersedes open items above.
12. [ ] **Main green + pushed (by 20:00).**
    - Review `ml-wider-gap-13wf`: take the `/enroll` import fix. The workflow `enroll_gate` 20→13 needs a CHANGELOG line or a CONTRACT review. Hold EnsembleV2 until it's evaluated.
    - Add jsdom and hypothesis as dev deps. Fix the enroll TS7053 errors.
    - Ask Codex 1 via REQUESTS to fix `test_fixture_reproducibility`.
    - Hub: catch out-of-order ticks and engine errors; ack late ticks.
    - Add `MODEL_BACKEND`. The e2e pins fallback, plus a paced `twobme_ml` variant.
    - Run `gate.sh all`, then push main and the tags.
13. [ ] **First deploy with B (by 21:30).**
    - Real secrets, plus a startup guard against example or empty values.
    - Stub voice pinned.
    - `deploy.sh`, then the e2e against https://2bme.tech; fill SMOKE.md; VM snapshot.
14. [ ] **Wire `twobme_ml` (by 22:00).**
    - Server deps and image; `models._fit` → `twobme_ml.update.retrain` with holdouts; fallback on failure.
    - Show `model_backend` on the identity card.
15. [ ] **§5.3 security fixes + regression tests (by 22:30).**
    - TOTP only in `fallback_mfa`, with factor re-enroll gated (voice routes via REQUESTS to Codex 2).
    - New device at 0.30; register, enroll-mode and train gated to R3/admin.
    - Row-level eligibility across a reset; keep `ModelInfo` on failure; revoke candidates before an arming.
16. [ ] **Presence in the root layout (by 23:00)**, then the real agent run with A.
17. [ ] **Voice:** merge ws-voice after the gate; add `hearsay[server]`; stub honesty (`simulated` flag + badge, admin-only fake decision); issuer failure → TOTP, not 503. Go/no-go Sun 01:00.
18. [ ] **Privacy defense in depth (by 23:30):** transitions validated against `app_categories.json`, `last_tick_json` from validated blocks, marker text capped.
19. [ ] **Overlay hardening (by Sun 00:30):** hoist `useDevFlag`, remove the default menu, fail-closed lock, resnapshot on device appear, `refreshMe` on 4401.
20. [ ] **Admin floor (1 h), then admin-lite (P1, by Sun 03:00):** see §2.4.
21. [ ] **README and landing truth pass:** two audiences and the stats; no unsupported claims; "Live" only after TLS passes.
