# 2bME — IMPLEMENTATION.md

> **Event:** HackGT 13. **Hard stop for code:** Sun Sep 27, 08:00 ET. **Devpost:** 12:00 ET, then submit the link at expo.hexlabs.org.
> **Team:** 2 humans (A = enrolled owner, B = attacker/ops) and 3 coding agents: **Claude** (§6), **Codex 1** (§7) and **Codex 2** (§8).
> **Confirmed decisions:**
> - macOS Python agent + browser presence/SDK; Python core + Next.js.
> - Hybrid voice verifier.
> - Impostor data from teammates only.
> - Backboard.io deferred.
> - Build both the 2bME voice step-up and the NSA Hearsay submission.
> - Domain: 2bme.tech. Tiger Data, ElevenLabs and Vultr accounts are ready.
>
> The source of truth for the product vision is `goal.txt`; §1 restates it and it is paramount.
> - **PROPOSED 2026-09-26, pending sign-off — not yet pinged to Codex 1/2:** `newGoal.txt` (root) refines the product split and does not replace `goal.txt`. The Electron **overlay** is the product surface for the enrolled individual (pill → voice/MFA step-up → lock/unlock, already A6). The **`.tech` website** is repositioned as the **admin/org control panel**: synthetic, anonymized multi-employee sessions, org-wide anomaly/insider-threat detection, and an audit trail of trust-score changes, alerts, challenges and admin actions — not a second consumer front-end. See §2.4.

## 0. How to use this document
- **Everyone** reads §0–§5. Then read only your own workstream: **§6 Claude**, **§7 Codex 1**, **§8 Codex 2**.
- **Ownership (§4):** never edit files you don't own. If you need something changed, append it to `contracts/REQUESTS.md` and move on to your next queue item.
- **Contract freeze (CP0, target Sat 02:30 ET):**
  - What freezes: feature names and order (`feature_spec.yaml`), WS messages, `trust_config.yaml`, shared types (`twobme_common.types`), ports, and fixture formats.
  - After CP0, adding a nullable feature or an optional field is additive and needs only a line in `contracts/CHANGELOG.md`.
  - Renaming or removing anything needs a Claude commit prefixed `CONTRACT:` and a ping to the other agents.
- **VERIFY** marks something that hasn't been confirmed. Run the §11.1 smoke test for it before you build on it.

### 0.1 MVP (P0) is exactly this, and it is never cut
1. The macOS agent captures keyboard, mouse, scroll, app/window events and chords. It builds privacy-safe evidence blocks, sends them over wss to Vultr for scoring, and 2bme.tech shows a live trust gauge, chart, per-modality bars and "why" chips.
2. Enrollment works from the overnight class-level logs plus a structured top-up, and the dashboard has **Train** and **Retrain now** buttons. The identity model is versioned and shown on an identity card.
3. A takeover marker makes trust fall, and a proactive voice challenge appears. Behavior alone never blocks.
4. Voice flow:
   - ElevenLabs speaks the prompt.
   - Scribe checks the spoken phrase.
   - Analysis: **DSP/FFT features**, ECAPA speaker match and DF_Arena anti-spoof.
   - Outcomes: VERIFY, BLOCK_IMPOSTOR or BLOCK_SPOOF. A live clone-attack tool is included.
5. The `/shop` $2,000 checkout returns a 3DS-style result: Y (approved), C (challenge) or N (declined). It covers two stolen-session variants:
   - same laptop: behavior degrades trust;
   - remote cookie: the co-presence check fails and the 0.30 prior applies.
6. Tiger: hypertables, columnstore compression, the `trust_1m` aggregate, `/history-min`, and `/tiger/stats`.
7. Evidence for "the signals identify a person": per-modality and fused A-vs-B EER, a branch-ablation chart, an identification confusion matrix, and time-to-detection (TTD) over at least 5 live trials, all on `/lab`.
8. A landing page, a "What left this laptop" viewer, and expo mode (reset, re-arm, 2-min script).
9. Hearsay:
   - a zero-shot safety TSV submitted early;
   - C5-lite ranked fusion;
   - an amd64 Docker image;
   - a Hearsay README.
10. TOTP as the MFA fallback. The goal says "voice / MFA".

### 0.2 Pre-cut
Start these only after CP4 (Sat 19:00) is green:
- Admin/org roster page (§2.4, PROPOSED): synthetic multi-employee sessions on the `.tech` site
- B6 browser behavioral scoring (the presence beacon itself is P0)
- automatic B7 schedule
- learned C4 team head
- C5-train SSL head
- extra Hearsay analyzers and the analyst agent
- `identity_centroids` / pgvector identification
- hour-of-day chart
- landing animations
- the `/status` page (a footer strip is P0)
- rumps menubar

## 1. Mission and non-negotiables (from goal.txt, paramount)
1. **Continuous identity.** Instead of trusting a session because someone logged in correctly, keep asking whether the operator is still the authorized user, and output a **continuous trust score**. Credentials alone never buy high trust (§5.4).
2. **Strongest demo.** Enroll ONE person, learn their normal behavior, and visibly detect when someone else takes over. Also *demonstrate that the collected information is enough to distinguish individuals* (§7 B5-min, `/lab`).
3. **The behavioral signature.** Every leaf maps to a concrete feature; see the §5.1.8 traceability table and the `test_signature_coverage.py` test:
   - Keyboard: hold, inter-key latency, digraph/trigraph timing, cadence, pause/burst, correction.
   - Mouse: velocity, acceleration, curvature, jerk, click timing, hover/dwell.
   - Scroll: velocity, burst length, inter-scroll timing, reversals.
   - Workflow: app switching, task-switch latency, transition patterns, window/tab behavior, keyboard↔mouse transitions.
   - Temporal: frequency, burstiness, idle intervals, periodicity, FFT.
4. **Privacy is part of the product.**
   - Never record typed content, passwords, clipboard, document text, window titles, URLs or key identities.
   - Anonymize **on the device**, and send only aggregated blocks (§2.2).
5. **Risk-based step-up.**
   - Known user: confidence about 97%, frictionless $2,000 purchase (Y).
   - Stolen session: confidence about 31%, then step-up, then a voice or MFA challenge, then verify (Y) or block (N).
6. **Voice layer.** ElevenLabs speaks a random phrase. We extract FFT and spectral features plus a speaker embedding, and an anti-spoof check **must catch ElevenLabs clones**.
7. **Sponsors, each used genuinely:**
   - Tiger Data: history, baselines, anomalies, and changes over time.
   - Vultr: hosting and inference, plus Serverless Inference for explanations.
   - ElevenLabs: prompts, STT, and the red-team corpus.
   - .tech: a polished live site.
   - Visa: a clearly labelled mock.
   - NSA Hearsay: TSV, Docker image and README.
   - Backboard: deferred (§12).

## 2. Architecture
```
 MacBook (A = enrolled owner; B = attacker takes the same laptop)
 ├─ twobme-agent (Python 3.12 + PyObjC, launched from Terminal.app with Input Monitoring)
 │   listen-only CGEventTap + NSWorkspace + CGWindowList poll (no titles) + lock/unlock + secure-input
 │   → RAM ring ≤60 s (keycodes never leave RAM) → key class + chord kind on capture thread
 │   → twobme_features: non-overlapping EVIDENCE blocks per modality + 30 s TEMPORAL context (Welch PSD)
 │   → wss://2bme.tech/ws/agent  (SQLite outbox; HTTPS batch fallback)
 │   ← trust / challenge (opens https://2bme.tech/verify?c=…) / lock / unlock / mode
 └─ Browser → https://2bme.tech (Next.js static export, same-origin /api + /ws)
      landing · login · dashboard · enroll · shop · verify · history · lab  (+ presence beacon, P0; SDK blocks, P1)
      [reframing to admin/org panel in progress — see §2.4; pages above unchanged for now]
 Vultr VM vhp-8c-16gb-amd (ewr) — Docker Compose: Caddy (TLS, static web) → FastAPI (1 worker)
   ├─ DeviceHub (in-memory, persisted to devices.trust_state): TrustEngine, UserModel scorer, challenge/lock state machine
   ├─ voice (hearsay profile="stepup"): Silero VAD → Scribe STT ‖ ECAPA ‖ DF_Arena(1 window) ‖ DSP/FFT → decision
   ├─ async batch writer → Tiger Cloud (us-east-1): hypertables, columnstore, caggs, pgvector
   └─ Vultr Serverless Inference (P1): 2-sentence anomaly explanations from feature z-scores only
 Vultr batch box (temporary, Hearsay): hearsay profile="hearsay" → TSV, dev set, feature harvest, amd64 image
```
**Hot path:** a tick every 5 s → score blocks in memory → TrustEngine → push to agent and dashboard → queue rows for Tiger, which a writer flushes every 1–2 s. Tiger is never on the hot path. It is the history, baseline, training and judge-panel store.

### 2.2 Privacy boundary (enforced by `scripts/check_privacy.sh` in the merge gate)
- **Keycodes stay on the capture thread.** The keycode is mapped immediately to a **hand-level key class** (§5.1.0) and a **chord kind**, then dropped. We don't use finger zones: an 8-zone letter sequence can be decoded like T9, so it counts as content.
- **Only aggregates leave the device**: percentiles, rates and counts per block. No per-key sequence is ever transmitted, hashed or not. All digits collapse into one `DIGIT` class, so PINs and card numbers can't be recovered.
- **Mouse** is sent only as statistics of trajectories normalized by the display diagonal. Absolute coordinates never leave the device.
- **Apps** become an on-device category (browser/ide/terminal/chat/docs/media/system/other). No bundle IDs, titles or URLs are sent.
- **Secure Event Input** (password fields) means the agent flags `secure_input`. The keyboard is then *missing*, not anomalous.
- **Voice:** challenge audio is scored and then deleted. Only embeddings and scalar scores are stored. The `/privacy` section of the landing page discloses that ElevenLabs Scribe processes challenge audio; `STT_BACKEND=local` switches to faster-whisper instead.
- **Dev-only local log:** `~/.2bme/logs/*.jsonl` holds hand-level classes. It stays on A's laptop, is never uploaded or committed, is never used as a fixture, and is deleted after the event.
- **What the gate fails on:** `kCGWindowName`, `event.key`, `clipboardData`, `InputEvent.data`, `bundleIdentifier` or a keycode reaching any logger, serializer or transport.
- **Voice disclosure (exact wording for `/privacy`):** "Our server deletes challenge audio after scoring and stores only embeddings and scores. ElevenLabs processes the prompt and STT audio and, on our plan, retains it in account history (Zero Retention is enterprise-only). `STT_BACKEND=local` avoids this."
- **No audio in git:** a pre-push hook rejects `*.wav|*.mp3|*.webm` outside `tests/fixtures/synthetic/`.

### 2.3 Demo topology
- **Demo laptop:** A's MacBook, trackpad only, Bluetooth off, a USB cardioid mic on a stand, on the phone hotspot.
  - One Chrome profile, `2bME-Owner`, is the macOS default browser and is logged in as `a@`. Nobody logs in as `b@` on it; B's voice enrollment uses a separate profile, `2bME-B`, with the same mic.
  - The agent runs under `caffeinate -dimsu scripts/agent_loop.sh` in a dedicated Terminal.app window (a restart loop in the same window keeps the TCC grant).
- **Observer screen:** a **second laptop** logged in as `admin@` (role `observer`).
  - It shows the dashboard in stage layout: big gauge, chart, TTD stopwatch, feed, and Mark takeover / Reset / Re-arm buttons.
  - Its session is never revoked by device locks, and it never anchors trust.
- **Attacker kit:** B's laptop or phone running the attack tool (§8 C2.7), plus a small speaker.
- **Backup video:** a tablet loops it.
- **Caddy:** `www.` and `app.` get a 308 redirect to `https://2bme.tech`. Cookies are host-only on 2bme.tech, and every URL uses the apex domain.

### 2.4 Two UIs (PROPOSED 2026-09-26 — draft for review, not yet pinged to Codex 1/2)
Per `newGoal.txt`: there are two front ends with different jobs, not one consumer app.
- **The overlay is the product** for the enrolled individual: the always-on trust pill, full-screen voice/MFA
  step-up, and the lock/unlock screen (already built, A6). This is where an individual consumer's continuous
  identity check actually happens.
- **The `.tech` site becomes the admin/org control panel.** Its audience is a cyber admin watching an
  organization, not the enrolled individual. It should show:
  - a roster of **synthetic, anonymized employee sessions** (newGoal.txt suggests ~20) — live trust score,
    last alert, binding state, per employee;
  - org-wide anomaly / insider-threat surfacing (who's drifting, who's mid-challenge, who got locked);
  - an audit trail of trust-score changes, alerts, challenges and admin actions.
- **Reuse, don't rebuild:** `/dashboard` already renders exactly one device's live trust gauge, chart,
  modality bars, why-chips, event feed and identity card (§6 A3) — that becomes the **per-employee drill-in**
  view an admin opens from the roster, unchanged in substance. The new work is narrow: one roster page
  (`web/src/app/admin/` or similar, Claude-owned like the other core pages in §4) that lists N synthetic
  sessions built from mocked/replayed data — **no real multi-tenant backend is required for this**, per
  newGoal.txt's own "synthetic sessions... first anonymized" framing. `/history` and `/lab` keep their current
  jobs (per-device history; the A-vs-B identification evidence for the mission's §1.2 claim) and just become
  reachable from the roster instead of standalone nav items.
- **Not affected:** `/shop` and `/verify` stay exactly what they are — the Visa-style demo scenario and the
  voice/MFA step-up flow — since §1.5/§1.7 and `newGoal.txt` line 105 keep Visa as a labelled demo, not a
  product surface. `/enroll` (Codex 1) and the voice components (Codex 2) are unaffected; this only touches
  Workstream A's own pages plus one new page, so it doesn't require a `CONTRACT:` commit — file ownership in
  §4 doesn't change.
- **Timeline:** hard stop for code is Sun Sep 27 08:00 ET (~16 h from this note). This is scoped as P1 —
  attempt it after every §0.1 MVP item is solid, not instead of one. If time runs out, the current single-user
  `/dashboard` plus the `admin@` observer role already tell a coherent story and are an acceptable fallback.

## 3. Stack and pins (Sep 2026)
- **Python 3.12** everywhere, via a `uv` workspace. scipy 1.18 and numpy 2.5 need ≥3.12, and torch has not been tested on the dev Mac's 3.14.
- **Server:**
  - `fastapi==0.141.*`, `uvicorn[standard]==0.54.*`, `pydantic>=2`, `pydantic-settings`
  - `asyncpg==0.31.0`, `pgvector==0.5.0`
  - `numpy`, `scipy==1.18.1`, `scikit-learn==1.9.1`, `joblib`, `pandas`, `pyarrow`
  - `openai==3.19.*` (Vultr inference), `pyotp`, `argon2-cffi`, `itsdangerous`
- **Agent:** `pyobjc-framework-Quartz==12.2.2`, `pyobjc-framework-Cocoa==12.2.2`, `websockets==17.1`, `httpx`, `keyring`, `rich`, `numpy`, `scipy`.
- **Voice (`hearsay`):**
  - CPU `torch` (VERIFY with speechbrain), `speechbrain==1.1.1`
  - `transformers==4.57.6` (needed for DF_Arena's remote code), `huggingface_hub`
  - `soundfile==0.14.0`, `soxr`, `librosa==0.11.0` (not 1.0), `audiomentations==0.43.1`
  - `silero-vad==6.2.3`, `jiwer==4.0.0`, `elevenlabs==2.69.0`, `faster-whisper==1.2.1`
  - `praat-parselmouth==0.4.7` (GPL, disclosed), `lightgbm==4.7.0`
  - system `ffmpeg libsndfile1`
  - Extras: `hearsay[server]` and `hearsay[detect]`. The Hearsay image installs only `[detect]`.
- **Web:** Node 22, pnpm, latest stable Next.js (App Router, TypeScript, `output:'export'`), Tailwind v4, shadcn/ui, Recharts, framer-motion, lucide-react, vitest.
- **Infra:** Docker Compose v2, `caddy:2.11.4`, Tiger Cloud, tiger CLI v0.25, vultr-cli v3.11.
  - Install the Tiger MCP server for both coding assistants: `tiger mcp install claude-code` and `tiger mcp install codex`.
- **Tiger DDL:**
  - Only `CREATE TABLE … WITH (tsdb.hypertable, tsdb.partition_column=…, tsdb.chunk_interval=…, tsdb.segmentby=…, tsdb.orderby=…)`.
  - Never the legacy `create_hypertable()` or pgai `ai.*`, which were removed on 2026-06-30.
  - `CALL` procedures and `refresh_continuous_aggregate` must run in autocommit.

## 4. Repo layout and ownership
```
2bme/  IMPLEMENTATION.md CLAUDE.md AGENTS.md README.md(.tech + Hearsay judge box) .env.example
       pyproject.toml uv.lock .python-version                                  [Claude]
contracts/  feature_spec.yaml trust_config.yaml messages.md api.md event_log.md schemas/ CHANGELOG.md REQUESTS.md [Claude]
            key_classes.json app_categories.json                               [Codex 1, by 01:45]
            fixtures/ticks/*, fixtures/reports/*                               [Claude]
            fixtures/events/*, fixtures/expected/*                             [Codex 1 generator]
packages/common/   twobme_common: types.py (all cross-package DTOs), spec.py, config.py        [Claude]
packages/features/ twobme_features                                                              [Codex 1]
packages/ml/       twobme_ml: model, trust, eval, cli                                           [Codex 1]
packages/hearsay/  hearsay (step-up + Hearsay), APT_DEPS.txt, download-models                   [Codex 2]
agent/             twobme_agent                                                                 [Codex 1]
server/app/        FastAPI: main, config, auth, db/*, core/{hub,ports,events,policy,explain,context,presence}, routers/* [Claude]
server/app/voice/  router, issuer, service, startup  (Claude commits a STUB at A0; ownership → Codex 2 at CP0) [Codex 2]
infra/             docker-compose.yml, docker-compose.dev.yml, Caddyfile, Dockerfile.base, Dockerfile.api, deploy.sh, migrations/ [Claude]
web/               package.json, lockfile, next.config, tsconfig, layout, design system, src/lib/{api.ts,live.ts,contracts.ts(generated)} [Claude]
web/src/app/{page(landing),login,dashboard,history,lab,overlay}                                  [Claude]
overlay/           Electron shell for the on-laptop overlay (loads /overlay; see §6 A6)                   [Claude]
web/src/app/enroll/  + web/src/sdk/ (presence.ts, sdk blocks)                                    [Codex 1]
web/src/app/{shop,verify}/ + web/src/components/voice/* + web/public/worklets/*                  [Codex 2]
hearsay_submission/  README.md, RULES.md, RUNTIME.md, Dockerfile, predictions/, figures/        [Codex 2]
reports/   eval.json [Codex 1], redteam.json + hearsay.json [Codex 2]   (committed; no personal data)
scripts/   core_* [Claude], sig_* [Codex 1], voice_* [Codex 2], gate.sh + check_privacy.sh [Claude]
ops/       queue_<agent>.md, STATUS.md (humans + agents append)
data/      (gitignored) models/, logs/, redteam/, hearsay/
```
**Dependencies:**
- Each `packages/*/pyproject.toml` belongs to its package owner.
- Agents run `uv lock` locally but never commit `uv.lock`; Claude regenerates it on each merge.
- Web dependencies were pre-approved at A0: vitest for Codex 1. Codex 2 uses only native Web Audio.

**Git:**
- Each agent works in its own `git worktree` on its own branch: `ws-core`, `ws-signals`, `ws-voice`.
- **Merge gate:** `scripts/gate.sh`, which runs that stream's tests, `check_privacy.sh` and `core_e2e_local.sh`.
- Claude merges any branch that passes the gate **within 30 minutes of a request**. Checkpoints are tags.
- From CP1 on, `main` auto-deploys to the VM after every merge (`deploy.sh`).
- Never commit `.env`, keys, audio or `data/`.

**Unattended agents:**
- Before a human sleeps, they write `ops/queue_<agent>.md`: ordered tasks, done-criteria, and "if blocked → REQUESTS.md → next item".
- Agents run pre-approved commands scoped to their own worktree. They never push to main or deploy without a human.
- All agents run in tmux, so the awake human can attach from anywhere.

## 5. Shared contracts (frozen at CP0)

### 5.1 Feature spec v1 (`contracts/feature_spec.yaml`)
`feature_spec.yaml` is the **only ordering source**:
```yaml
modalities:
  keyboard: { n_unit: key_downs, n_ref: 20, features: [ {name: kb.hold_p50, unit: ms, label: "key hold", headline: true}, … ] }
```
- **Order:** list order is canonical and append-only within a `schema_version`. Reordering or removing a feature bumps `schema_version`.
- **Wire vs DB:** blocks on the wire carry a dict that contains **exactly** `names(modality)`, with `null` meaning insufficient evidence. In the DB, `features real[] = vectorize()`.
- **Two layers:**
  - **Evidence blocks** don't overlap. They close per modality by count or timeout, and they drive the trust engine.
  - **Temporal context** covers the trailing 30 s with a 5 s hop and is heavily down-weighted.
- **Units:** times in ms; mouse distances in display-diagonal units (dd).

**5.1.0 Key classes** (`key_classes.json`, Codex 1). These map macOS kVK codes and browser `event.code` values:
- **Letters:**
  - `L_LETTER`: Q W E R T A S D F G Z X C V B
  - `R_LETTER`: Y U I O P H J K L N M plus `, . ; / ' [ ] \`
- **Digits:** `DIGIT` covers every digit and keypad digit.
- **Other:** `PUNCT` (- = `), `SPACE`, `ENTER`, `BKSP` (including forward-delete), `TAB`, `ESC`, `ARROW`, `NAV`, `FKEY`, `SHIFT`, `CMD`, `CTRL`, `OPT`, `CAPS`, `OTHER`.

**Chord kinds** are classified on the capture thread from keycode plus flags, and the browser uses `event.code` plus modifiers:

| Chord kind | Keys |
|---|---|
| `tab_new` | ⌘T |
| `tab_close` | ⌘W |
| `tab_jump` | ⌘1–9 |
| `tab_cycle` | ⌃Tab, ⌃⇧Tab, ⌘⇧[ ] |
| `app_switch_kbd` | ⌘Tab |
| `window_cycle` | ⌘` |
| `other_cmd` | any other ⌘ chord |

The agent hotkeys ⌃⌥⌘M and ⌃⌥⌘R are consumed by the agent and excluded from features.

**5.1.1 keyboard.** A block closes at 20 non-modifier, non-autorepeat key-downs, or after 15 s with at least 8. `n_ref` = 20.
- **Hold times:** `kb.hold_p50`, `kb.hold_iqr`, `kb.hold_p50_L`, `kb.hold_p50_R`, `kb.hold_p50_space`.
- **Flight times:**
  - `kb.dd_p50`, `kb.dd_iqr` (press→press; gaps over 1500 ms excluded)
  - `kb.ud_p50`, `kb.ud_iqr` (release→next press)
  - `kb.rollover_frac`
- **Digraphs:** `kb.dd_p50_same_hand`, `kb.dd_p50_cross_hand`, `kb.dd_p50_letter_space`, `kb.dd_p50_space_letter`.
- **Trigraphs** (LETTER×3, span from press 1 to press 3): `kb.tri_p50`, `kb.tri_iqr`.
- **Cadence:**
  - `kb.speed_kps` (within bursts; a gap of 500 ms or more ends a burst)
  - `kb.burst_len_mean`, `kb.pause_rate` (gaps over 1 s per key)
- **Corrections:** `kb.bksp_rate`, `kb.bksp_run_mean`, `kb.pre_bksp_dd_p50`, `kb.post_bksp_dd_p50`.
- **Modifiers:** `kb.shift_lead_p50`, `kb.chord_rate`.

**5.1.2 mouse.** A block closes at 5 actions, or after 15 s with at least 2. `n_ref` = 5.
- **Actions** (Antal & Egyed-Zsigmond):
  - A stroke ends after 300 ms without movement or at a button event. A gap over 10 s always splits.
  - Strokes with fewer than 4 samples are dropped.
  - Types: MM (move only), PC (move then click), DD (drag).
- **Resampling:** trajectories are resampled to **60 Hz** before any derivative, which neutralizes macOS 26.2 downsampling and 120 vs 60 Hz displays.
- **Features** are medians across the actions in the block:
  - **Kinematics:** `ms.v_p50`, `ms.v_p90`, `ms.a_p50`, `ms.jerk_p50`, `ms.curv_p50`, `ms.angvel_p50`.
  - **Path shape:** `ms.straightness_p50`, `ms.path_p50`, `ms.dur_p50`, `ms.t_peak_frac_p50`, `ms.submoves_p50`.
  - **Clicks:** `ms.click_hold_p50`, `ms.pre_click_pause_p50`, `ms.dblclick_p50`.
  - **Action mix:** `ms.frac_pc`, `ms.frac_dd`, `ms.dir_entropy`.
  - **Hover/dwell:** `ms.dwell_rate`, `ms.dwell_p50`. A dwell is speed below 0.01 dd/s for more than 100 ms. It is geometric, because the agent doesn't know UI elements.

**5.1.3 scroll.** A block closes at 3 bursts, or after 30 s with at least 1. `n_ref` = 3.
- A burst ends after a 300 ms gap. Only finger-phase events count, and momentum is excluded from velocity.
- **Features:**
  - `sc.burst_dur_p50`, `sc.burst_events_p50`, `sc.burst_dist_p50`
  - `sc.v_peak_p50`, `sc.v_mean_p50`, `sc.iei_cv_p50`, `sc.inter_burst_p50`
  - `sc.reversal_rate`, `sc.momentum_frac`, `sc.horizontal_frac`

**5.1.4 workflow.** A block is emitted every 60 s if there was at least 1 app switch or window change. `n_ref` = 3 transitions.
- **Features:**
  - `wf.switch_rate`, `wf.switch_latency_p50` (focus change → first input)
  - `wf.kbd_switch_frac` (the `app` event's `via=cmdtab`)
  - `wf.win_change_rate`, `wf.tab_chord_rate` (tab_* chords)
  - `wf.k2m_p50`, `wf.m2k_p50`, `wf.app_dwell_p50`
- **Transitions:** the block also carries `transitions {"ide>browser":2}` over categories only, stored in `extras`.
  - At score time, `UserModel` computes the feature **`wf.markov_ll`**: the mean per-transition log-likelihood under the user's smoothed matrix (Dirichlet α=5 toward uniform).
  - The workflow block then takes the same one-class → typicality → LLR path as every other modality. There is no separate unbounded Markov LLR.

**5.1.5 temporal.** This is the tick's context block, with modality `temporal`. It covers the trailing 30 s and needs at least 30 events. `n_ref` = 100 events.
- **Rate and burstiness:** `tp.rate`, `tp.B` (Goh–Barabási), `tp.Bn` (Kim–Jo), `tp.M` (memory).
- **Idle:** `tp.idle_frac` (gaps over 2 s), `tp.idle_p50`, `tp.idle_p90`.
- **Spectrum:** Welch over 20 ms event-count bins (`nperseg=256`).
  - Band powers: `tp.bp_0_05`, `tp.bp_05_2`, `tp.bp_2_5`, `tp.bp_5_10`, `tp.bp_10_25`.
  - `tp.spec_entropy`, `tp.peak_hz`, `tp.centroid_hz`.
- **Periodicity:** `tp.acf_peak_lag`, `tp.acf_peak`.
- **PSD for display:** the block also carries `psd: float[32]`, the log PSD from 0–25 Hz, used by the dashboard's "Rhythm spectrum (FFT)" panel.

**5.1.6 Headline columns.** Exactly 15, named by lowercasing the feature name and replacing `.` with `_`:
- **Keyboard:** kb_hold_p50, kb_dd_p50, kb_ud_p50, kb_speed_kps, kb_bksp_rate
- **Mouse:** ms_v_p50, ms_curv_p50, ms_straightness_p50, ms_click_hold_p50
- **Scroll and workflow:** sc_v_mean_p50, wf_switch_rate
- **Temporal:** tp_rate, tp_b, tp_idle_frac, tp_peak_hz

**5.1.7 Class-level event log** (`contracts/event_log.md`). This format is used by the recorder, `replay`, `features_from_events`, fixtures and parity tests.
- **Line 1:** `{"ev":"header","schema_version":1,"display":{"w_pt","h_pt","hz"},"pointer":"trackpad"|"mouse","label":"genuine"|"impostor","actor":"a"|"b"}`
- **Key and chord:**
  - `{"t_ns","ev":"key","down","slot","cls","autorepeat","inj"}`. `slot` is a per-run counter reused for the matching key-up. It is never the keycode.
  - `{"t_ns","ev":"chord","kind"}`
- **Mouse:** `{"t_ns","ev":"mouse","kind":"move|down|up|drag","x_pt","y_pt","button","inj"}`. Coordinates exist only in local logs; committed fixtures are synthetic.
- **Scroll:** `{"t_ns","ev":"scroll","dy","dx","continuous","phase","momentum"}`
- **App and window:** `{"t_ns","ev":"app","cat","via":"cmdtab|click|other"}`, `{"t_ns","ev":"window"}`
- **OS and secure input:** `{"t_ns","ev":"os","event":"screen_locked|screen_unlocked|sleep|wake"}`, `{"t_ns","ev":"secure_input","on"}`
- **`t_ns`:** calibrated agent-monotonic ns for native events, `performance.now()·1e6` for the browser.
- **Label changes:** `{"t_ns","ev":"label","label","actor"}` when the takeover hotkey toggles.

**5.1.8 Signature traceability.** `test_signature_coverage.py` asserts that every leaf has at least one non-null feature on `genuine_A`.

| Goal leaf | Features |
|---|---|
| **Keyboard** | |
| hold | `kb.hold_*` |
| inter-key latency | `kb.dd_*`, `kb.ud_*` |
| digraph | `kb.dd_p50_{same_hand,cross_hand,letter_space,space_letter}` |
| trigraph | `kb.tri_*` |
| cadence | `kb.speed_kps` |
| pause/burst | `kb.burst_len_mean`, `kb.pause_rate` |
| correction | `kb.bksp_*`, `kb.pre/post_bksp_dd_p50` |
| **Mouse** | |
| velocity | `ms.v_*` |
| acceleration | `ms.a_p50` |
| curvature | `ms.curv_p50`, `ms.angvel_p50` |
| jerk/smoothness | `ms.jerk_p50`, `ms.submoves_p50` |
| click timing | `ms.click_hold_p50`, `ms.pre_click_pause_p50`, `ms.dblclick_p50` |
| hover/dwell | `ms.dwell_*` |
| **Scroll** | |
| velocity | `sc.v_*` |
| burst length | `sc.burst_*` |
| inter-scroll timing | `sc.inter_burst_p50`, `sc.iei_cv_p50` |
| direction/reversals | `sc.reversal_rate` |
| **Workflow** | |
| app switching | `wf.switch_rate` |
| task-switch latency | `wf.switch_latency_p50` |
| transition patterns | `wf.markov_ll` (from `transitions`) |
| window/tab behavior | `wf.win_change_rate`, `wf.tab_chord_rate` |
| keyboard↔mouse | `wf.k2m_p50`, `wf.m2k_p50` |
| **Temporal** | |
| frequency | `tp.rate` |
| burstiness | `tp.B`, `tp.Bn`, `tp.M` |
| idle | `tp.idle_*` |
| periodicity | `tp.acf_*` |
| FFT | `tp.bp_*`, `tp.spec_entropy`, `tp.peak_hz`, `tp.centroid_hz` |

**5.1.9 Closure and edge rules** (Python and TypeScript must match these exactly):
- **Block timeout** is measured from the block's first event. If the minimum isn't met by the timeout, discard the block and start fresh.
- **Keyboard:**
  - A keyboard block closes at its 20th key-down, but hold and ud values are finalized only when the matching key-ups arrive, up to 1.5 s later. Any still missing become null.
  - **Modifiers:** on `flagsChanged` with keycode k, toggle the tracked state of k. Resync all modifiers to up when `flags & 0xFFFF0000 == 0`. Caps Lock counts as a key-down only.
- **Scroll:** an event is a user event when `MomentumPhase == 0`, whatever `ScrollPhase` is. That keeps plain mouse-wheel events.
- **Mouse:** stroke splitting and dwell detection (no move for >100 ms) run on **raw** events. Resample each stroke to 60 Hz only afterwards, for derivatives.
- **Temporal:** the temporal model trains and calibrates on every 6th context window only, so the windows are non-overlapping.

### 5.2 WebSocket protocol (`contracts/messages.md`; pydantic in `twobme_common.types`)
**Time:**
- Every timestamp on the wire and in the DB is UTC ISO-8601 with milliseconds and a `Z` suffix.
- The agent computes intervals from calibrated CGEvent monotonic ns. For wall time it computes `wall = mono + (time_ns − monotonic_ns at start) + offset` and sends timestamps already corrected; the server never corrects them again.
- **Clock offset:** `clock_ping {t0_ns}` → `clock_pong {t0_ns, server_ns}`. The agent uses the lowest-RTT sample of its last 8 pings and repeats every 60 s.
- **Skew:** for a non-late tick, if `|t_end − now| ≥ 30 s` the server substitutes its receive time and sets `flags.clock_skew`.
- **Replay** uses current wall time. `--speed` above 1 is only for ingest and eval, never for live-trust demos.

**Agent → `/ws/agent`** (`hello` must come first):
```json
{"type":"hello","v":1,"device_token":"…","run_id":"<uuid4 per process>","resume_session_id":null,"requested_mode":"enroll|monitor|null",
 "agent_version":"0.1.0","schema_version":1,"os":"macOS 26.4","pointer":"trackpad","display":{"w_pt":1512,"h_pt":982,"hz":120},"last_unlock_at":null}
{"type":"tick","run_id":"…","session_id":"…","seq":812,"t_end":"…","flags":{"secure_input":false,"injected":0,"pointer":"trackpad","late":false,"idle_s":0.0,"clock_skew":false},
 "counts":{"keys":24,"mouse_moves":410,"clicks":2,"scroll_events":0,"app_switches":0},"activity":[5,7,3,0,4],
 "blocks":[{"modality":"keyboard","t_start":"…","t_end":"…","n":20,"features":{…all names…}}, {"modality":"workflow",…,"transitions":{"ide>browser":1}}],
 "context":{"modality":"temporal","t_start":"…","t_end":"…","n":312,"features":{…},"psd":[…32]}}
{"type":"marker","label":"takeover_start|takeover_end|note","t":"…"}      // ⌃⌥⌘M toggles start/end
{"type":"os_event","event":"screen_locked|screen_unlocked|sleep|wake","t":"…"}
{"type":"demo","action":"reset"}                                              // ⌃⌥⌘R (expo mode)
{"type":"clock_ping","t0_ns":…}
```
- `activity` holds input events per 1 s bucket over the tick. It feeds the sparkline and the co-presence check, and is not stored.
- `counts` goes to `trust_ticks.flags`.

**Idempotency and sessions:**
- The server dedupes on `(device_id, run_id, seq)`. `seq` restarts at 0 for each run.
- Late ticks are stored under their own `session_id`. The hub drops `late` blocks with `t_end < now−60 s` before scoring, so they are stored only.
- Tiger inserts use `ON CONFLICT DO NOTHING`.

**Server → agent:**
- `welcome` `{device_id, user_id, session_id, mode, model_version|null, label, actor}`
- `trust` `{seq|null, confidence, display, level, locked, per_modality:{m:{llr, delta}}}`
- `challenge` `{challenge_id, trigger, verify_url, expires_at}`
- `lock` `{reason}` and `unlock` `{}`
- `mode` `{mode}`
- `clock_pong`

**Server → `/ws/live`** (cookie auth; a user sees their own devices, admin sees all):
- **Envelope:** `{"type","device_id","t","data"}`.
- **`snapshot`:**
  ```
  {device:{id,label,pointer,mode,locked,lock_reason,last_seen}, session_id, label, actor,
   trust:TrustState, trust_history:[{t,confidence,level}] (10 min), markers:[{t,label}] (10 min),
   model:ModelInfo|null, enroll:EnrollProgress, open_challenge:ChallengeOut|null,
   recent_events:[…50], last_tick_json (for "What left this laptop")}
  ```
- **`trust`:** TrustState plus `seq`.
- **`block_scored`:** `{modality, t_start, t_end, n, typicality, llr, q, delta, top:[{feature, label, unit, z}]}`.
- **`context`:** `{psd, features}`, for the FFT panel.
- **`enroll_progress`:** `{counts:{m}, gates:{m}, ready}`.
- **`model`:** ModelInfo.
- **`anomaly`:** `{id, kind, severity, trust_before, trust_after, top_features, action, challenge_id, explanation|null}`. It is re-sent with the same id once the explanation arrives.
- **Other event types:**
  - `challenge` `{challenge_id, trigger, status, attempt, expires_at}`
  - `voice_result` (VoiceResult without the spectrogram, plus `challenge_id`)
  - `decision` (DecisionOut plus `action` and `amount_cents`)
  - `marker` `{label, text?}`
  - `mode`, `lock`, `unlock`, `label` `{label, actor}`
  - `presence` `{binding:'co-present'|'remote', score}`

### 5.3 REST (`contracts/api.md`)
Everything is under `/api`. WebSockets are under `/ws`. `api.2bme.tech` is an alias with the identical path space. Users authenticate with a cookie; the agent sends `Authorization: Bearer <device_token>`.

**Auth:**
- `POST /auth/login {email,password}` sets a signed httpOnly `SameSite=Lax` cookie. `POST /auth/logout`. `GET /me`.
- Seeded accounts: `a@`, `b@`, `admin@2bme.tech`.
- **A web login never changes device trust.**

**Devices:**
- `POST /devices/register` (cookie) → `{device_id, device_token}`.
- **Binding:** a web session binds to the cookie user's most recently seen device. `/pair` is P2.

**Presence (P0):**
- `POST /web/presence {buckets:[{t_s, keys, pointer, wheel}]}` every 2 s, counts only.
- **co-present** requires both of these over the last 20 s, evaluated at lag ∈ {−1, 0, +1} s:
  - `pearson(browser, agent activity)` ≥ 0.5 over at least 5 browser-active seconds;
  - agent count ≥ 0.8 × browser count in at least 80% of browser-active seconds.
- Otherwise the binding is **remote**.

**Enroll and models:**
- `POST /enroll/mode {device_id, mode}`
- `GET /enroll/status?device_id` → EnrollProgress
- `POST /enroll/train {device_id, source:"tiger"|"logs"}` → `{job_id}`, followed by a `model` event
- `POST /models/retrain {device_id}` (Retrain now)
- `GET /models/active?user_id` → ModelInfo `{status, job_id, version, trained_at, n_blocks, enabled_modalities, metrics, headline_medians, learned_since_enroll}`
- `GET /models/history?user_id`

**Decisions:**
- `POST /decisions {action:"view"|"export"|"add_payee"|"password_change"|"purchase", amount_cents?}` and `POST /checkout/authorize {amount_cents, card_last4}` both return DecisionOut:
  `{decision_id, status:"final"|"pending", decision:"allow"|"step_up"|"block", trans_status:"Y"|"C"|"N", confidence, tier, binding, reasons[], challenge_id|null, verify_url|null}`
- `GET /decisions/{id}` returns DecisionOut plus `final_decision, final_trans_status, resolved_at`.

**Voice** (Codex 2, `server/app/voice`):
- **Enrollment:** `POST /voice/enroll/start` → `{enroll_id, phrases[5]}`. `POST /voice/enroll` (multipart: `enroll_id`, wav×5) → `{enrolled, n_utts, intra_cos}`.
- **Creating challenges:** `POST /voice/challenges {reason:"unlock"|"redteam"|"sandbox"}`. The server issues `proactive` and `step_up` challenges itself.
- `POST /voice/challenges/{id}/prompt-ended`: ChallengeFlow calls it on the audio `ended` event. It sets the status to `prompt_ended`, which the attack tool waits on.
- **Reading challenges:** `GET /voice/challenges/{id}` → ChallengeOut. `GET /voice/challenges/{id}/prompt.mp3` starts the 30 s TTL on its first GET, capped at `issued_at + 120 s`.
- `POST /voice/challenges/{id}/response` (multipart: `wav`, `client_prompt_end_ms`) → `{result: VoiceResult, outcome: VoiceOutcome, next?:{phrase, prompt_url, expires_at, attempt}}`.
- `POST /voice/totp/verify {challenge_id, code}`. `POST /voice/totp/enroll` → `{otpauth_uri}`.

**History (Tiger):**
- `GET /history/sessions`
- `GET /history/trust?session_id&from&to` (gap-filled)
- `GET /history/anomalies`
- `GET /history/baseline?modality` (session medians vs the enrollment baseline)
- `GET /history/drift` (`drift_30m`, P1)
- `GET /tiger/stats`

**Reports:** `GET /eval/report?kind=eval|redteam|hearsay` (served from `reports/*.json`).

**Demo and admin:**
- `POST /demo/label {device_id, label, actor}`
- `POST /demo/marker {device_id, label}`
- `POST /demo/reset {device_id}` (admin, `DEMO_MODE=1`, target < 1 s):
  - cancels pending challenges and clears the lock;
  - opens a new session and sets label to genuine/a;
  - sets L to logit(0.97) with reason `operator_reset`, shown in the feed as an operator action, not an authentication;
  - leaves models and baselines untouched, and pushes a `snapshot`.
- `POST /tiger/compress-now` (admin): `SELECT compress_chunk(c, if_not_compressed => true) FROM show_chunks('feature_blocks', older_than => INTERVAL '1 hour') c`, for a guaranteed judge moment.
- `POST /demo/rearm {device_id, confidence:0.31}` sets L to logit(0.31) and writes a `rearm` marker, for a repeatable attack beat.
- `GET /demo/redteam/active-challenge?device_id` (admin only, and only when `DEMO_MODE=1`) → `{challenge_id, phrase, status}`, for the live attack tool.
- `POST /demo/purge-session {session_id}` (removes volunteer test data).

**Health:** `GET /healthz` (ok only after the voice warm-up) and `GET /status`.

**Browser SDK (P1):** `POST /web/blocks`.

### 5.4 Trust contract (`contracts/trust_config.yaml`; engine = `twobme_ml.trust`, policy = server)
**State:**
- `L = logit P(same enrolled person)`, clamped to `[−logit(cap), logit(cap)]` with **cap = 0.995**.
- `confidence = sigmoid(L)`, and `display = min(99, round(100·conf))`.
- The TrustEngine lives **per device**. It is persisted to `devices.trust_state` after every tick and restored on server start and on `hello`. It is never recreated on reconnect.

**Anchors.** Credentials never buy high trust.
- `L = logit(0.97)` is set **only** by:
  - a voice `VERIFY`, or a TOTP pass;
  - `/demo/reset`;
  - activating a trained model while the label is not impostor.
- An OS `screen_unlocked` event sets `L = logit(0.80)`, but only if a `screen_locked` preceded it in the same `run_id` and the device isn't locked. A 0.80 anchor is still below the 0.90 R3 threshold, so a purchase needs about 5 genuine blocks before it is frictionless.
- Neither a web login nor a WS or agent reconnect changes L. On `hello`, the idle hazard is applied over the disconnected interval.
- **Server restart:** the hub restores L from `devices.trust_state`. If that is more than 10 min stale, it uses 0.30.
- A new device starts at 0.97 in enroll mode and at 0.30 in monitor mode.
- **Binding.** A web session is bound to its user's most recent device when both hold:
  - the heartbeat is **< 30 s** old;
  - the session is co-present.

  Otherwise the binding is **remote** and the session uses 0.30 — the goal's "31%" case, deterministic.
- The agent POSTs ticks over HTTPS while the WS is down, so a Wi-Fi hiccup doesn't cost A the binding.

**Per-block LLR:**
- From typicality t: `llr = clip(llr_direct if set else −ln β_m − (β_m−1)·ln(1−min(t, 1−1e−6)), −4, 4)`.
- The genuine user gives t ≈ U(0,1). The impostor model is t ~ Beta(1, β).
- **β_m comes only from `trust_config.yaml`.** It defaults to 6, and `twobme-ml eval` writes tuned values to `trust_config.tuned.yaml`.

**Update per tick:**
1. **Idle hazard first:**
   - `dt = t_end − t_prev`
   - `idle_part = clamp(idle_s − 60, 0, dt)`; if `dt > 15`, then `idle_part = max(idle_part, dt − 60)`
   - `keep = 2^−(idle_part/600 + (dt − idle_part)/14400)`
   - `L = logit(sigmoid(L)·keep)`
   - This is one-way: waiting never raises trust.
2. **Evidence:**
   - `ΔL = κ·Σ_{every BlockScore in tick} w_m · q · f(llr)`
   - `q = min(1, n/n_ref_m)`, and `f(x) = min(−D + D(1+1/C)/(1/C + e^{−x/B}), C)`
   - **Parameters:** C=1.0, D=1.0, B=0.5 (unit slope at 0), κ=0.5.
   - **Weights:** `w = {keyboard 1.0, mouse 1.0, scroll 0.5, workflow 0.4, temporal 0.05}`.
   - A missing modality contributes 0.

**Simulated defaults (be honest in the pitch).** These use the exact config above, with 2-tick arming:
- **Genuine user with mild autocorrelation (AR ρ=0.6):** below 0.90 on about 3% of ticks, and 87% of 30-minute runs never arm a challenge.
- **Genuine user with strong context drift (ρ=0.9):** below 0.90 on about 14% of ticks. That is why A enrolls on the demo choreography (§10) and why continuous update exists.
- **Time to detection (arming):**
  - a clearly different typist (per-block AUC about 0.86): median about 55 s from the cap, or about 40 s from a 0.97 anchor;
  - a similar typist (AUC 0.75): about 1.5–2 min.
- **Tuning:** B5 tunes β, κ, D and w on replay against FA/h(0.40) ≤ 1, R3 friction ≤ 5% on demo-context blocks, and median TTD ≤ 60 s.
- **Rejected setting:** the first draft's C=0.5/D=1.5 clipped most genuine reward, giving about 12 FA/h and roughly 20% R3 friction.
- **Checkout rule:** A clicks Pay only when the shop's confidence badge shows ≥ 0.95.

**Levels:**
- `learning` (no model, or enroll mode). Here ΔL isn't applied and R3 always steps up.
- By confidence band: `normal` ≥ 0.80, `watch` 0.40–0.80, `suspicious` < 0.40.
- `locked` (a sticky flag).
- The engine returns only the band; the hub overrides it with `learning` or `locked`.

**Behavior alone never blocks.**
- **Arming.** A proactive challenge is **armed** after **2 consecutive ticks** below 0.40. Arming sends a dashboard event and an agent notification. The challenge re-arms once confidence recovers above 0.60, or after a 60 s cooldown.
- **One open challenge per device.** The first high-risk action on the bound browser **consumes** the armed challenge: same `challenge_id`, fresh phrase. A step-up while a challenge is open attaches to it (`decisions.challenge_id`).
- **Expiry.** An unanswered proactive challenge expires after 180 s, while the level stays `suspicious`. It does **not** lock, and every action keeps stepping up.

**Lock** (`devices.locked, locked_at, lock_reason`):
- **Entry:** set only by `BLOCK_SPOOF` or `BLOCK_IMPOSTOR` on a proactive or step_up challenge, or by a failed TOTP after `FALLBACK_MFA`.
- **Gray zone never locks the owner.** On unlock and recovery challenges, a gray-zone result gives RETRY with a new phrase, at most twice, then TOTP. Gray zone means `cm_p_spoof ∈ [T_CM−0.15, T_CM)`, or ASV between T_low and T_high.
- **While locked:**
  - L is pinned to its minimum.
  - Blocks are still scored, for display only.
  - Every `/decisions` call returns block/N with the reason `device_locked`.
  - The agent receives `lock`.
- **Unlock:**
  - `POST /voice/challenges {reason:"unlock"}` is allowed only for a cookie session created after `locked_at`, at most 3 per 10 min.
  - A VERIFY sets locked=false and L = logit(0.97), and sends `unlock` then `trust` to the agent.
  - BLOCK_* on an unlock keeps the device locked and records a severity-5 anomaly.
- **The `redteam` and `sandbox` triggers** run the full pipeline but have **no** trust, lock or decision effects. Calibration, rehearsals and the `/lab` voice sandbox, where judges can try their own voice, use them.
- **BLOCK_* revokes** only `a@`'s user sessions, never observer sessions. The `device_binding` cookie (httpOnly, Secure, SameSite=Lax, 30 d) survives logout, lock and revocation.

**Policy table** (evaluated after ingesting the tick that contains the click):

| Tier | Actions | Allow if conf ≥ | Otherwise |
|---|---|---|---|
| R0 | view | 0.40 | step_up |
| R1 | purchase < $100 | 0.60 | step_up |
| R2 | purchase $100–499, export | 0.80 | step_up |
| R3 | purchase ≥ $500, add_payee, password_change | **0.90** | step_up |

- The result is `block` only when the device is locked.
- `trans_status`: Y = allow, C = step_up, N = block.

**Decision resolution:** only `core.events.voice_decided` resolves decisions.
- **VERIFY** turns an attached pending decision into allow/Y only when all of these hold:
  - the same verified user created it;
  - it came from the same web session;
  - it was created within 120 s;
  - no BLOCK_* has occurred since.

  An order the attacker started stays **N** after any BLOCK_*, even if the owner later verifies.
- **BLOCK_\*:** attached pending decisions become block/N.
- **FALLBACK_MFA:** the decision stays pending until TOTP passes (Y) or 90 s elapse (N).
- **Markers** are ground truth for the stopwatch and eval only. They **never** reach the scorer or TrustEngine (tested).

### 5.5 Tiger schema (`infra/migrations/`, idempotent)
**Plain tables:**
- `users`: id, email, pw_hash, handle, tz, totp_secret_enc, enrollment_status.
- `devices`: id, user_id, token_hash, label, os, pointer, display jsonb, last_seen, **mode**, **locked, locked_at, lock_reason**, **trust_state jsonb**.
- `sessions`: id, user_id, device_id, channel (desktop|web), status, started_at, ended_at.
  - A session ends on `screen_locked` or 10 min after the WebSocket closes without a resume.
  - A `hello` with a matching `resume_session_id` and `last_seen` < 10 min reuses the session.
- `models`: id, user_id, channel, version, schema_version, trained_at, n_blocks jsonb, metrics jsonb, headline_medians jsonb, artifact_path, is_active, parent_version.
- `voice_profiles`: id, user_id, speaker_embedding **vector(192)**, utt_embeddings jsonb, spectral_summary **vector(64)** (64-bin mel LTAS in dB), n_utts, intra_cos, created_at.
- `voice_challenges`: id, user_id (subject), device_id, session_id, trigger (proactive|step_up|unlock|redteam), status, attempt, phrase, issued_at, prompt_first_get_at, expires_at, asv_cos, cm_p_spoof, spec_sim, phrase_wer, onset_ms, voice_confidence, decision, findings jsonb.
- `decisions`: id, time, user_id, device_id, session_id, action, amount_cents, tier, binding, confidence, decision, trans_status, status, challenge_id, final_decision, final_trans_status, resolved_at, reasons jsonb, label, actor.
- `identity_centroids` (P2).

**Hypertables:**
- **`feature_blocks`:**
  - Columns: time (block end), block_start, user_id, device_id, session_id, channel, modality, schema_version, mode, n, `features real[]`, the 15 headline columns, extras jsonb, typicality, llr, q, delta, model_version, **label, actor**, `baseline_eligible` (mode = enroll AND label IS DISTINCT FROM 'impostor'), `update_candidate`, flags jsonb.
  - Options: `WITH (tsdb.hypertable, tsdb.partition_column='time', tsdb.chunk_interval='1 hour', tsdb.segmentby='device_id', tsdb.orderby='time DESC')`.
  - Unique on `(session_id, modality, time)`.
  - The auto-created columnstore policy runs only daily, so replace it so compression is visible during the hackathon. Do the same for `trust_ticks`:
    ```sql
    CALL remove_columnstore_policy('feature_blocks', if_exists => true);
    CALL add_columnstore_policy('feature_blocks', after => INTERVAL '2 hours', schedule_interval => INTERVAL '15 minutes');
    ```
- **`trust_ticks`:** time, device_id, session_id, user_id, confidence, display, logit, delta_logit, level, kb_llr, ms_llr, sc_llr, wf_llr, tp_llr, **challenge_issued bool**, model_version, label, actor, flags jsonb. 1-hour chunks.
- **`anomalies`:** time, id, user_id, device_id, session_id, kind (trust_drop|takeover_suspected|voice_spoof|voice_impostor|lock|redteam_tool), severity, trust_before, trust_after, top_features, action, challenge_id, explanation, resolution.
  - `PRIMARY KEY (id, time)`, because a unique index must include the partition column.
  - 1-day chunks.
- **Writer:** use `INSERT … ON CONFLICT DO NOTHING` via `executemany`. Never COPY into a table with a unique index. If a batch fails, log it and retry row by row.
- **`markers`:** time, device_id, session_id, label, text.

**Continuous aggregates:**
- `trust_1m`: real-time (`materialized_only=false`). Per device per minute: avg, min and max confidence, `last(confidence, time)`, and `count(*) FILTER (WHERE challenge_issued) AS n_stepups`.
- `block_baseline_hourly`: count, avg and stddev of the headline columns `WHERE baseline_eligible`. It uses plain aggregates, so the toolkit isn't needed; VERIFY whether it is available.
- `anomaly_daily`.

**Other queries:**
- `drift_30m` (P1): per headline feature, `(mean per 30 min − enrollment mean)/enrollment std` over genuine rows, plus the centroid shift per model version.
- Hour-of-day baseline: P2.

**Deferred:** retention policies and the `app_ingest`/`app_read` roles are P2; use one DB user.

### 5.6 Shared types and interfaces
**Package rule:** every cross-package DTO lives in **`twobme_common.types`** (Claude, CP0). It is pure pydantic with no numpy. `hearsay` may import only `twobme_common` from the twobme packages. `scripts/core_gen_ts.py` generates `web/src/lib/contracts.ts` from these models' JSON Schema.
```python
Modality = Literal['keyboard','mouse','scroll','workflow','temporal']
class Display(BaseModel): w_pt: float; h_pt: float; hz: int
class Block(BaseModel): modality: Modality; t_start: datetime; t_end: datetime; n: int; features: dict[str, float|None]
    transitions: dict[str,int]|None = None; psd: list[float]|None = None
class Deviation(BaseModel): feature: str; z: float            # robust z = (x−median)/(1.4826·MAD)
class BlockScore(BaseModel): modality: Modality; t_end: datetime; n: int; typicality: float|None; llr_direct: float|None; top: list[Deviation]
class ModalityContribution(BaseModel): typicality: float|None; llr: float; q: float; w: float; delta: float; n_blocks: int
class TrustState(BaseModel): t: float; logit: float; delta_logit: float; confidence: float; display: int
    level: Literal['learning','normal','watch','suspicious','locked']; per_modality: dict[Modality, ModalityContribution]; reasons: list[str]
VoiceDecision = Literal['VERIFY','RETRY','FALLBACK_MFA','BLOCK_SPOOF','BLOCK_IMPOSTOR']
class Spectrogram(BaseModel): f_hz: list[float]; t_s: list[float]; db: list[list[float]]   # 64 x 128
class VoiceResult(BaseModel): decision: VoiceDecision; voice_confidence: float; asv_cos: float|None; cm_p_spoof: float|None
    spec_sim: float|None; phrase_wer: float|None; onset_ms: int|None; dsp: dict[str,float]; findings: list[str]
    stage_ms: dict[str,int]; spectrogram: Spectrogram|None
class ChallengeOut(BaseModel): challenge_id: UUID; trigger: str; status: str; attempt: int; phrase: str; prompt_url: str; expires_at: datetime|None; verify_url: str
class VoiceOutcome(BaseModel): device_locked: bool; resolved_decisions: list[dict]   # [{decision_id, decision, trans_status}]
class DecisionOut(BaseModel): ...  # §5.3
class ModelInfo(BaseModel): ...; class EnrollProgress(BaseModel): ...
```
**Codex 1 interfaces:**
```python
# twobme_features
class Accumulators:
    def __init__(self, spec: FeatureSpec, display: Display): ...
    def add_key(self, t_ns, down: bool, slot: int, cls: str, autorepeat: bool) -> None
    def add_chord(self, t_ns, kind: str) -> None
    def add_mouse(self, t_ns, x_pt, y_pt, kind: str, button: int) -> None
    def add_scroll(self, t_ns, dy, dx, continuous: bool, phase: int, momentum: int) -> None
    def add_app(self, t_ns, cat: str, via: Literal['cmdtab','click','other']) -> None
    def add_window_change(self, t_ns) -> None
    def poll(self, now_ns) -> list[Block]; def context(self, now_ns) -> Block | None
def features_from_events(events: Iterable[dict], spec) -> list[tuple[int, list[Block], Block|None]]   # per 5 s tick
# twobme_ml
class UserModel:
    @classmethod
    def train(cls, df, cfg) -> "UserModel"   # df cols: time, block_start, session_id, modality, n, features(list, spec order), extras, label, actor, schema_version
    def score_block(self, block: Block) -> BlockScore | None
    def save(self, d); @classmethod def load(cls, d)
class TrustEngine:
    def on_tick(self, t_end: float, idle_s: float, scores: list[BlockScore]) -> TrustState   # t_end = epoch seconds
    def anchor(self, p: float); def to_dict(self); @classmethod def from_dict(cls, d)
```
**Claude interfaces** (`server/app/core/ports.py`, `events.py`, `db/repo_voice.py`):
```python
class ChallengeIssuer(Protocol):
    async def issue(self, *, device_id: UUID|None, subject_user_id: UUID, session_id: UUID|None,
                    trigger: Literal['proactive','step_up','unlock','redteam'], decision_id: UUID|None) -> ChallengeOut
    async def open_for_device(self, device_id: UUID) -> ChallengeOut | None
async def challenge_status(challenge_id, status, attempt) -> None           # broadcasts `challenge`
async def voice_decided(challenge_id, result: VoiceResult) -> VoiceOutcome   # every scored attempt; effects only on terminal
# repo_voice: insert_profile(...)->UUID, get_active_profile(user_id), insert_challenge(row), update_challenge(id, **f), get_challenge(id)
```
**Codex 2 interfaces** (the `server/app/voice/__init__.py` exports, plus hearsay):
```python
router: APIRouter            # mounted at /api/voice
issuer: ChallengeIssuer
async def startup() -> None  # preload ECAPA + DF_Arena + prompt pool, one warm-up inference; lifespan awaits it (timeout)
def score_audio(x: np.ndarray, sr: int, profile: Literal['stepup','hearsay']) -> CMResult   # {margin, p_spoof|None, llr|None, analyzers, ms}
```
Claude's A0 commits a **stub** `server/app/voice/`. The router returns canned `VoiceResult`s, selected by the `X-Fake-Decision` header, and a `FakeIssuer` uses a fixed phrase. That breaks the import cycle and lets CP1 run without Codex 2.

### 5.7 Environment (`.env.example`)
- **Site and security:**
  - `DOMAIN=2bme.tech`, `PUBLIC_BASE_URL=https://2bme.tech`, `ACME_EMAIL`, `SESSION_SECRET`
  - `DEMO_MODE=1`, `ADMIN_TOKEN`
- **Tiger:** `TIGER_DATABASE_URL` (…?sslmode=require).
- **ElevenLabs:**
  - `ELEVENLABS_API_KEY`
  - `ELEVENLABS_PROMPT_VOICE_ID`: a premade voice, **never** a clone.
  - `ELEVENLABS_REDTEAM_VOICE_A`: the IVC of A, **used only by the attack tool**.
  - `ELEVENLABS_TTS_MODEL=eleven_flash_v2_5`, `ELEVENLABS_STT_MODEL=scribe_v2`
  - `STT_BACKEND=elevenlabs|local`
- **Voice thresholds:** `VOICE_T_ASV_HIGH`, `VOICE_T_ASV_LOW`, `VOICE_T_CM`, `VOICE_T_SPEC`. These are set by the C0.5 and C4 calibration.
- **Vultr inference:** `VULTR_SERVERLESS_INFERENCE_API_KEY`, `VULTR_INFERENCE_BASE_URL=https://api.vultrinference.com/v1`, `VULTR_INFERENCE_MODEL`.
- **Paths:** `MODEL_DIR=/app/data/models`, `HF_HOME=/models/hf`.
- **Agent:** `TWOBME_API=https://2bme.tech`. The agent calls `${TWOBME_API}/api/…` and `wss://…/ws/agent`, and keeps its token in the Keychain.

### 5.8 Report files (JSON Schemas in `contracts/schemas/`, samples in `contracts/fixtures/reports/`)
- **`reports/eval.json`** (Codex 1):
  ```
  {generated_at, n_blocks:{a:{m},b:{m}},
   modalities:{m:{auc, eer, roc[[fpr,tpr]] ≤200, n_genuine, n_impostor, beta}},
   fused:{auc, eer}, ablation:[{removed:m, fused_eer}],
   identification:{labels:["a","b"], confusion, accuracy},
   live_trials:[{t_start, ttd_s, detected}],
   splice:{n, ttd_s:{median, p90, values}, undetected_300s_frac, fa_per_hour:{"0.40","0.10"}, r3_friction_frac}  (P1),
   notes[]}
  ```
- **`reports/redteam.json`** (Codex 2): `{generated_at, delivery:"acoustic"|"injected", thresholds, genuine:{n, frr}, impostor:{n, far}, attacks:[{class, generator, n, far_asv_only, far_cm_only, far_fused, mean_asv_cos}]}`
- **`reports/hearsay.json`** (Codex 2): `{generated_at, rules_confirmed:bool, dev:{n, min_dcf_a, min_dcf_b, eer}, detectors:[{name, min_dcf_a, min_dcf_b}], fusion, ablation[]}`

---
## 6. Workstream A: Claude (lead and integrator: contracts, backend, Tiger, core web, deploy)
**A0 — P0, timeboxed to 75 min, CP0 at about 02:30.** Everything in this step comes before other Claude work.
- Create the uv workspace, the pnpm/Next scaffold (layout, shadcn theme, design tokens) and the §4 layout.
- Write the §5 contracts. That includes `twobme_common.types`, `spec.py` (`names`, `vectorize`, `devectorize`, with NaN/inf mapped to None), `config.py`, and one hand-written example tick and block per modality.
- Write the report schemas, `core_gen_ts.py` → `contracts.ts`, and the stub `server/app/voice/`.
- Write `gate.sh` and `check_privacy.sh`, then `.env.example`, `CLAUDE.md` and `AGENTS.md`.
- Tag the result `cp0-contracts`.
- Synthetic event fixtures are Codex 1's job, not Claude's.

**A1 — Backend core (P0; the walking skeleton is deployed by CP1).**
- **App setup:**
  - App factory with a lifespan that runs migrations, opens the asyncpg pool (register pgvector after migrations), restores `devices.trust_state`, loads the active models and `await voice.startup()` (with a timeout), then starts the writer.
  - **Single uvicorn worker.**
  - **Training:** `await writer.flush()`, load the blocks, then `await asyncio.to_thread(UserModel.train, df, cfg)`. It is a few hundred rows and a few seconds, so there's no process pool; a forked torch process can deadlock.
  - Training is refused while a challenge is in flight, and entirely after demo freeze.
  - Voice runs in its own threadpool.
- **Degraded mode (P0).**
  - At startup, users, devices, active models (from `MODEL_DIR/{user}/active.json`, never from the DB) and voice profiles (mirrored to `data/voice_profiles/*.npz`) are loaded into memory.
  - If Tiger is unreachable, the API still starts and `/status` reports `tiger=down`. Login, decisions, checkout and voice keep working from memory.
  - The writer is a bounded 50k-row deque that drops the oldest rows and counts the drops.
  - History pages show their last cached payload.
- **Auth:** argon2 password hashing, signed cookies, and device tokens stored hashed.
- **`/ws/agent` hub:**
  - Session rules come from §5.5 and dedupe from §5.2.
  - Stamp every stored row with the device's current `label`/`actor`.
  - For each block, call `score_block`. The `temporal` context is scored as well.
  - Then `TrustEngine.on_tick`, then apply the level, lock and proactive-challenge state machine (§5.4).
  - Broadcast `trust`, `block_scored` and `context`, and persist `trust_state` after every tick.
- **Enroll and models:**
  - `devices.mode` is server-authoritative. `hello.requested_mode` is applied as if `/enroll/mode` had been called.
  - Training reads Tiger rows **or** the parquet `twobme-ml` builds from logs. Tiger is not required for the first model.
  - Model versions are kept with rollback, and `update_candidate` is stamped at ingest (§7 B7).
  - A successful train sets mode to monitor and applies the anchor from §5.4.
- **Decisions, checkout and co-presence** (`core/presence.py`), then the §5.4 policy, the one-open-challenge rule, `voice_decided` resolution, and TOTP (P0, done by CP4).
- **Demo endpoints, `/status` and `/healthz`.**

**A2 — Tiger (P0).**
- Migrations 001–004 (extensions, registry, hypertables, caggs), a small idempotent runner, the repository layer and the async batch writer (`executemany`/COPY every 1–2 s, `ON CONFLICT DO NOTHING`).
- Queries:
  - recent sessions (LATERAL join)
  - gap-filled trust (`time_bucket_gapfill` with explicit start and finish)
  - anomalies with their challenge outcome
  - the session-vs-enrollment baseline
  - `/tiger/stats`, from `hypertable_columnstore_stats()` and `timescaledb_information.jobs`
- `drift_30m` is P1.

**A3 — Core web (Claude owns the layout, design system, `api.ts` and `live.ts`).**
- **P0 by CP2:**
  - **login**
  - **dashboard**:
    - a live trust gauge and a 10-minute chart built from `snapshot.trust_history`, with bands at 80/40 and marker lines
    - per-modality contribution bars (delta)
    - "why" chips with human labels from the spec
    - an event feed
    - the identity card: `v{n} · +k blocks learned · updated hh:mm` plus a radar of `headline_medians`
    - a "Rhythm spectrum (FFT)" panel comparing the live PSD with A's enrolled mean
    - a "What left this laptop" drawer showing `last_tick_json`
    - controls:
      - an enroll/monitor toggle and **Train** / **Retrain now**
      - an **"Impostor at keyboard (B)" toggle**
      - Reset demo and Re-arm (31%)
      - an "Unlock with voice" button while locked
    - a **TTD stopwatch** that runs from the `takeover_start` marker to the first tick below 0.40, then freezes at "Detected in N s (M keyboard, K mouse blocks)"; the chart shades the takeover interval
    - **health pills:** agent heartbeat age, tap events/s, a red **SECURE INPUT — keyboard blind** banner, last block age per modality, RTT, voice_warm, and the ElevenLabs quota
    - `?stage=1` observer layout (§2.3), with Mark takeover on the observer screen, so the attacker never signals the system from the monitored laptop
- **P0 by CP4:**
  - `/` landing:
    - hero with a live trust line and a 3-step how-it-works
    - the goal.txt signature tree, with a live dot per leaf fed by the latest blocks
    - the privacy promise
    - a sponsor strip (Tiger, Vultr, ElevenLabs, .tech, NSA Hearsay; Visa marked "demo scenario, not affiliated")
  - `/history`-min: sessions, the trust timeline and anomalies with explanations, plus compression and jobs.
  - `/lab`-min: renders `reports/*.json` (ROC, ablation, confusion matrix, live TTD list, voice red-team table, Hearsay card) with a teammates-only honesty footnote.
  - A status footer strip.
- **Static export rules:** no dynamic route segments (use query params), and everything is same-origin.

**A4 — Deploy.** Humans do step 0 in hour 1, with no app code. Claude does the rest.
- **VM:** `vhp-8c-16gb-amd` in `ewr` from the Docker marketplace image (app 1125), with a Firewall Group allowing 22 from team IPs, 80/443 tcp and 443 udp.
- **DNS:** A records for @, www, app and api, checked with `dig`.
- **TLS and mic check:** Caddy serves a static `index.html` and `mictest.html`. Start with the Let's Encrypt staging CA, then switch to production. It passes when the mic works at https://2bme.tech/mictest.
- **Base image:** `infra/Dockerfile.base` is built **once on the VM**, and rebuilt only when `uv.lock` changes. It contains python:3.12-slim, ffmpeg, libsndfile1, CPU torch and every server and voice dependency.
- **Model weights:** `docker compose run --rm api python -m hearsay download-models` fills the `hf` volume.
- **API image:** `Dockerfile.api` is `FROM twobme-base` and copies the code last, so a deploy takes seconds.
- **Web build:** never uses the VM's own Node. Build inside `node:22`, or rsync a local `web/out`.
- **Compose:**
  - `caddy` proxies `/api/*` and `/ws/*` with `flush_interval -1` and sets `Permissions-Policy: microphone=(self)`.
  - `api` uses `expose`, never `ports`, and runs with `--workers 1 --proxy-headers --forwarded-allow-ips='*' --ws-ping-interval 20 --ws-ping-timeout 20`.
  - `www.` and `app.` get a 308 redirect to the apex domain.
- **No deploys Sun 09:00–11:30.** After any API restart, run one `sandbox` challenge before the next judge.
- **Deploy and recovery:**
  - `deploy.sh` does `git pull`, builds the web, then `up -d`.
  - Take VM snapshots after the first end-to-end run and at demo freeze.
  - `docker-compose.dev.yml` runs a local timescaledb-ha as an offline fallback; VERIFY that its tag includes vector and vectorscale.

**A5 — P1.**
- `core/explain.py`: on each anomaly, a background call to Vultr Serverless Inference. The input is trust before and after plus the top 5 `(label, z)` — never content. The output is 2 sentences, falling back to a template.
- `ContextStore` protocol plus `NoopContextStore` (§12).
- The `drift_30m` panel.
- `core_e2e_local.sh` (§11.2).

**A6 — On-laptop overlay (P0; added 2026-09-26 by user decision).** An Electron app (`overlay/`) on A's Mac:
- One transparent, always-on-top window that loads `https://2bme.tech/overlay` (`web/src/components/overlay/`) and resizes per mode.
- **pill** (normal: trust %, level, sparkline) → **prompt** when a proactive/step-up challenge is armed: full-screen, dimmed voice
  check that can be snoozed ("Not now") because behavior alone never blocks → **lock** when a voice check fails (BLOCK_*):
  full-screen, not dismissible, owner signs in again and unlocks with a fresh phrase (§5.4 unlock rules).
- It captures no input and talks only to the 2bME origin. While it holds `/ws/live`, the agent's `challenge` stays a
  notification (no `open verify_url`). Operator escape hatch ⌃⌥⌘⇧Q. `--hard-lock` adds macOS kiosk presentation while locked.
- Demo impact (§13): after "Mark takeover", the overlay takes over A's screen when the challenge arms; the clone beat runs in
  the overlay's voice check (or via /shop → C as before); BLOCK_SPOOF → lock screen; A unlocks from the lock screen.

## 7. Workstream B: Codex 1 (signals and models)
**B0 — Probe (P0, 30 min or less, hour 0).** Write the findings to `agent/PROBE.md`:
- `CGPreflightListenEventAccess` via ctypes
- the tap is created, `CGEventTapIsEnabled`, and events actually arrive
- CGEvent timestamp units, ns vs Mach ticks (timebase 125/3), self-calibrated against `time.monotonic_ns()`
- the mouse event rate
- `IsSecureEventInputEnabled`

**B0.5 — Recorder (P0, running on A's laptop by 01:45; no contract dependency).**
- Write `key_classes.json` and `app_categories.json` first.
- `twobme-agent record [--label genuine|impostor --actor a|b]` writes the §5.1.7 log to `~/.2bme/logs/`. Keycodes, bundle IDs and titles are never written.
- A runs it continuously from 01:45.
- `twobme-ml train --from-logs` must produce a model with no server and no Tiger.
- The CP1 deliverable is `data/eval/night.json`: per-modality A-vs-B block EER on real data.

**B1 — Agent (P0).**
- **Capture:**
  - A listen-only `CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, mask)`.
  - The callback only appends to a deque.
  - Re-enable the tap on `DisabledByTimeout`/`ByUserInput`, plus a 5 s watchdog (tap enabled, events arriving).
  - CGEvent fields: the source-PID injected flag, IsContinuous(88), PointDeltaAxis1/2(96/97), ScrollPhase(99), MomentumPhase(123), autorepeat.
  - Chord classification happens on the capture thread.
  - NSWorkspace activation maps the app to a category, then the bundle id is discarded.
  - CGWindowList is polled every 500 ms for the window number and PID only, **never** `kCGWindowName`.
  - Lock/unlock distributed notifications (VERIFY on 26.x; fallback: poll `CGSessionCopyCurrentDictionary`) become `os_event`.
- **Threads:**
  - main: CFRunLoop
  - featurizer: drains every 1 s and ticks every 5 s
  - asyncio: websockets, SQLite outbox, clock offset
- **CLI:**
  - `doctor`, `pair` (login + register + Keychain)
  - `run [--mode enroll|monitor] [--record]` with a live `rich` panel showing trust, level and per-modality delta bars
  - `replay --log f [--then g --at 120] [--speed k]`, which is P0: it backfills night logs and powers the stage replay lane
  - `mark`
- **Hotkeys:** ⌃⌥⌘M toggles takeover start/end and sends `marker`, which sets label/actor. ⌃⌥⌘R sends demo reset.
- **Server messages:**
  - `challenge` → an `osascript` notification only. `/shop`, `/dashboard` and `/verify` listen for `challenge` on `/ws/live` and open the modal in place. The agent runs `open <verify_url>` only if no browser bound to this device has had a `/ws/live` connection in the last 15 s.
  - `lock` → a notification
  - `unlock` → a notification
  - With `DEMO_MODE=1`, lock never runs `pmset displaysleepnow`.
- **Transport fallback:** while the WS is down, POST ticks over HTTPS (`/api/agent/ticks`).
- **Stage mode:** `twobme-agent doctor --stage` runs before every judge block and fails loudly unless all of these hold:
  - Input Monitoring is granted, the tap is enabled, and events arrived in the last 5 s
  - no Secure Event Input
  - pointer = trackpad, with no external HID mouse
  - Chrome is the default browser
  - Bluetooth is off
  - RTT is under 300 ms
  - `voice_warm=true`
  - ElevenLabs quota is above 5k
- **Before the expo:** turn off auto-lock and the screen saver, and run `pmset displaysleep 0`.
- **`agent/README.md`:**
  - Grant Input Monitoring to Terminal.app (keyboard **and** mouse) and restart Terminal.
  - Turn Secure Keyboard Entry off.
  - Always launch from the same app.
  - After the event, run `tccutil reset ListenEvent com.apple.Terminal`.

**B2 — Features (P0).**
- Implement §5.1 exactly, using names from the yaml.
- Resample mouse input to 60 Hz. Missing values are None.
- `scripts/sig_make_fixtures.py` generates `contracts/fixtures/events/{genuine_A,impostor_B}.jsonl` with realistic, distinct timing distributions for every modality, plus `fixtures/expected/*.json`, by CP1.
- Tests: fixture tests, property tests (a constant +30 ms flight delay shifts `kb.dd_p50` by about 30), and `test_signature_coverage.py`.

**B3 — Models (P0).**
- **Per modality:** `RobustScaler`, then ensemble members chosen by n_train:
  - under 20: the modality is disabled (zero evidence);
  - 20–60: scaled-Manhattan + `IsolationForest(n_estimators=300, max_samples=min(64, n))`;
  - 60–150: add `GaussianMixture(k=1, covariance_type='diag', reg_covar=1e-3)`;
  - over 150: `GaussianMixture(k=2, diag)` + `OneClassSVM(nu=0.05)`.
- **Typicality (calibrated to ~U(0,1) under the genuine user):**
  - The ensemble score s is the mean of each member's rank-normalized score against its reference set.
  - Reference scores are **out-of-fold**: 5 contiguous chronological folds with a 60 s purge gap; fit on 4, score the 5th.
  - The deployed model is fit on all blocks and scored against the OOF reference.
  - `t = (#{ref more anomalous than s} + 0.5)/(n_ref + 1)`, which lies in (0,1).
  - Save the OOF reference arrays in the artifact. Impute missing values with the training median.
  - The calibration folds must include natural-use data (the night `--record` logs), not only the structured games.
- **β (written to `trust_config.tuned.yaml`, never read from the model at score time):**
  - MLE on B's impostor blocks: `β̂ = −n/Σ ln(1−t_i)`, clamped to [2, 20].
  - If `n_imp < 10` or β̂ < 2, use the default 6 and flag the modality "weak".
- **Top deviations:** robust z.
- **Workflow:** `wf.markov_ll` is computed from `transitions`, then scored like the other features.
- **Enrollment gates:**
  - keyboard ≥ 100 blocks (about 2,000 keys)
  - mouse ≥ 60 (about 300 actions)
  - scroll ≥ 30, workflow ≥ 20
  - temporal ≥ 60 non-overlapping context windows
  - A modality under its gate is disabled.
- **Training data:** A's model trains on `baseline_eligible` rows (or `update_candidate` rows older than 10 min), excluding `actor='b'`.
- **Saving:** joblib plus `meta.json`.
- **CLI:** `twobme-ml train --from-db|--from-logs|--from-parquet`.

**B4 — TrustEngine (P0).** Implement §5.4 verbatim, reading `trust_config.yaml`. Tests:
- **Seeded Monte Carlo** (200 runs × 30 min, one keyboard and one mouse block per 5 s tick):
  - genuine, with t following an AR(1) ρ=0.6 process on U(0,1): confidence ≥ 0.90 on at least 95% of ticks, and no proactive arming in at least 85% of runs (simulated: 97.3% and 87%);
  - impostor, with t ~ Beta(1,6): median TTD to arming ≤ 60 s from the cap and ≤ 45 s from a 0.97 anchor (simulated: 55 s and 40 s).
- Idle never raises confidence. **Ticking every 5 s through 300 s of idle equals a single 300 s update, to within 1e-9.**
- Disconnect/reconnect mid-impostor never raises confidence.
- Confidence < 0.10 never yields `block` without a voice outcome (server policy tests).

**B5-min — Identity evidence (P0 by CP4) → `reports/eval.json`.**
- **Data:** A = genuine rows with a chronological 30% holdout; B = rows with `label='impostor'`.
- **Outputs:**
  1. Per-modality and fused block ROC/EER, with temporal as its own modality.
  2. Branch ablation: fused EER with each modality removed.
  3. Two-way identification: B's model is trained on `actor='b'` rows. Report the confusion matrix and accuracy.
  4. TTD for each of at least 5 live takeover trials, taken from the markers.
- **P1 extension (full B5):**
  - splice replay (gaps {0, 5, 30, 120} s, at least 20 splices), reporting TTD median/p90, % undetected within 300 s, FA/h and R3 friction;
  - β MLE and a sweep over κ, D and w → `trust_config.tuned.yaml`;
  - Claude promotes the tuned config after review.

**B6 — Presence (P0) and SDK blocks (P1).**
- **P0:** `web/src/sdk/presence.ts`, about 40 lines. It counts keydown, pointerdown and wheel events per 1 s bucket and POSTs `/web/presence` every 2 s.
- **P1:** TS keyboard and mouse block features. Names come from the spec; map `event.code` → class, never `event.key` or values; skip `type=password` and `autocomplete^=cc-` fields. Parity with Python must be within 1% on `fixtures/expected`.
  - Web blocks count only when the bound device has **no** fresh agent heartbeat; otherwise the evidence would be double-counted.

**B7-min — Continuous identity update (P0 by CP4).**
- `update_candidate` rule (Claude stamps it at ingest using this definition): confidence ≥ 0.95 over the preceding 60 s, llr ≥ +1, no open or failed challenge, label is not impostor, **or** the block falls within 60 s after a voice VERIFY.
- **Retrain now:**
  - Keep an enrollment anchor of at least 30%, change at most 10% of the data per update, and use a 10-minute quarantine.
  - Reject the new model if typicality on the anchor holdout drops or B's EER worsens by more than 1 point.
  - Versioning keeps `parent_version`.
- An automatic 15-minute schedule is P1.
- **Excluded from baseline and candidates:**
  - every block between a `takeover_start` marker and the next VERIFY;
  - every block in a session ended by `/demo/reset`;
  - every block in `sandbox` or `ephemeral` sessions.
- **`CONTINUOUS_UPDATE=false` from DEMO FREEZE.** The Sunday 06:30 top-up is the last training run: tag it `demo-final` by 06:45. After that there are no retrains, deploys or migrations.

**Enroll page (P0 by CP2): `web/src/app/enroll`.**
- A wizard showing live gate progress (`enroll_progress`).
- A typing textarea whose content is **discarded client-side** and never sent; the agent captures timing system-wide.
- Voice enrollment (Codex 2's `<VoiceEnroll/>`), TOTP enrollment, and a Train button.
- The click/drag target game and the scroll panel are P1.

## 8. Workstream C: Codex 2 (voice and Hearsay — one package, two profiles)
**C0 — P0, hour 0, on the batch box over SSH so weights and torch never cross venue Wi-Fi.**
- **Package skeleton and audio I/O:** soundfile + soxr → 16 kHz mono float32, with an ffmpeg fallback for webm/opus.
- **VAD:** Silero.
- **ECAPA:** `speechbrain/spkrec-ecapa-voxceleb`, fed numpy tensors.
- **DF_Arena:** `pipeline("antispoofing", model="Speech-Arena-2025/DF_Arena_500M_V_1", trust_remote_code=True)`. It truncates input to 64,600 samples, so window it manually.
- **Timing:** measure ms per window and write it to `hearsay_submission/RUNTIME.md`.
- **Fallback:** if DF_Arena isn't loaded by **02:15**, switch the CM for both uses to `garystafford/wav2vec2-deepfake-voice-detector` (Apache-2.0, where label 1 = fake).
- **Before the box exists:** write the package, the 300-word phonetically distinct wordlist, the TSV writer and minDCF.

**Rules checklist — Person A by 03:00, into `hearsay_submission/RULES.md` with sources.** Get it from the official PDF (NSA Drive or HackGT Discord #hearsay):
- score direction and range; metric code, P(attack) and costs
- the template path, header and filename format; test-set download
- Docker registry, architecture, GPU, network, time and memory limits
- any draft-TSV review or leaderboard, and its deadline; the final Hearsay deadline
- DiffSSD split, external-data and fingerprinting policy
- how techniques and "agentic orchestration" are judged
- the team file name

Until these are confirmed, they are flags in `hearsay/config.yaml`, never constants.

**C0.5 — Spoof smoke test (P0, Sat 03:00–04:30 with A; consent signed at 01:30).**
1. A records 90 s of free speech on the **demo USB mic**. Create the IVC `2bme-redteam-A` (VERIFY that the plan includes IVC) and set `ELEVENLABS_REDTEAM_VOICE_A`.
2. Generate 10 challenge-style phrases with `eleven_multilingual_v2` and `eleven_flash_v2_5` (pcm_16000).
3. A records 5 enrollment phrases plus the same 10 live; B records 10.
4. Deliver the clone two ways:
   - (a) acoustic: a phone or laptop speaker about 10 cm from the demo mic;
   - (b) injected: BlackHole 2ch as the input device (VERIFY install).
5. Score with the DF_Arena margin (1 window from onset) and the ECAPA cosine vs A's centroid.

**Decision at CP1:**
- If acoustic separates at least 8/10, the demo uses acoustic delivery.
- Otherwise, if injected separates at least 8/10, the demo uses injection ("attacker pipes a real-time clone into a virtual mic").
- Otherwise the C4 team head becomes P0 and C5 training is dropped.

Also set `VOICE_T_CM` v0 and record the clone's ASV cosine. If the clone falls below `T_ASV_LOW`, the demo line becomes "speaker check and anti-spoof both reject".

**C1 — Hearsay safety TSV (P0, done by 05:00).**
- **Batch box, provisioned by Person B at 01:00.** Try in order:
  1. `vcg-a16-3c-32g-8vram` in ewr (about $0.24/h; VERIFY that the gift credit covers it);
  2. otherwise `voc-c-16c-32gb-300s-amd` (16 dedicated vCPU, about $0.48/h);
  3. otherwise a Kaggle or Colab T4 for the harvest.
- **Throughput:** on CPU, run 4 workers × 4 torch threads; on GPU, fp16 autocast with batch 1.
- **Resumable:** append to `predictions.partial.tsv` every 50 files.
- **TSV writer (reused later):**
  - Read the **official template** and keep its header and row order byte-for-byte, matching rows by basename. Overwrite only column 2.
  - Score = `(rankdata(llr, 'average') + 0.5)/N`, written as `%.8f`. It is monotone and never saturates.
  - Assert the row count, that no 0.006 placeholder is left, and that every file was attempted. Unreadable files go to the **real end**.
  - `--direction synth_high|bona_high` is applied last.
  - Before every submission, run a **direction smoke test** on 20 real + 20 ElevenLabs clips.
- If a draft-review path exists, submit the safety TSV immediately.

**C1b — Feature harvest (starts P0 around 03:30, used by P1 work; runs unattended).**
- `hearsay extract --manifest … --out data/hearsay/cache/` does one forward pass per (clip, window, augmentation).
- It records: the DF_Arena margin, mean-pooled backbone layers {6, 12, 18, 24} (VERIFY the hook path; fallback is `facebook/wav2vec2-xls-r-300m` with `output_hidden_states`), the cheap DSP vector, silence stats and the condition profile.
- Output is parquet keyed by `sha1(audio) + analyzer_version`.
- Order: test clips first, then `hearsay_dev`, then the training manifest.

**C1c — `hearsay_dev` (P0 for Hearsay, frozen by 06:00).**
- About 800 clips, 70% real and 30% synthetic, from the DiffSSD val split plus held-out real speakers.
- At least 150 synthetic clips come from open-set generators (PlayHT, DiffGAN-TTS, UnitSpeech) plus our ElevenLabs clips.
- 70% pass through the test-condition simulator (below).
- `hearsay eval` reports each time:
  - **minDCF_a** (p_synth = 0.3, C_real_flagged = 4, C_miss = 1);
  - **minDCF_b** (ASVspoof5 formula with Pspoof = 0.05, Cmiss = 4, Cfa = 1, negated);
  - EER and pAUC at FPR ≤ 2%;
  - the 10 highest-scored *real* clips.
- **Every design choice is picked by mean(minDCF_a, minDCF_b). Only ranking matters, so calibration is irrelevant to the TSV.**

**C2 — Step-up service (P0), `profile='stepup'`, in `server/app/voice`.**
- **Phrases:**
  - 5 words drawn with `secrets` from the curated list (no digits or homophones).
  - A new phrase on every RETRY, with the same `challenge_id` and `attempt` incremented.
  - Never pass the phrase as Scribe keyterms.
- **Prompt:**
  - ElevenLabs `eleven_flash_v2_5` with the premade voice → `mp3_44100_128`.
  - **Pool:** generate it **once** into `data/prompt_pool/{id}.mp3` plus `pool.json` on a persisted volume. Entries are single-use, and the pool is topped up to 50 only when fewer than 20 unused remain.
  - Outside prod, `ELEVENLABS_MODE=stub` makes TTS a local beep plus the phrase and STT faster-whisper. Tests and CI never call ElevenLabs.
  - **Credit budget:** red-team generation ≤ 12k credits, with 5k reserved for Sunday. The generator refuses to run when the remaining quota is below 8k (`GET /v1/user/subscription`). `ELEVENLABS_API_KEY_BACKUP` is the fallback.
  - Show the phrase as text too.
- **Pipeline:**
  1. Resample the native-rate WAV to 16 kHz with soxr HQ (anti-aliased).
  2. VAD.
  3. `asyncio.gather` over Scribe `scribe_v2` STT (network) ‖ ECAPA ‖ DF_Arena ‖ DSP/FFT. **Always compute every score**, even when an earlier gate decides, so the UI can show that a speaker match alone would have passed.
- **CM input:**
  - The input is the concatenated VAD speech with 150 ms padding on each side.
  - `n = min(max_windows, ceil(len/64600))` windows, evenly spaced with the last one right-aligned. Anything shorter than one window is tile-padded by the extractor.
  - `max_windows` = 1 for the step-up and 3 for Hearsay.
  - Score = mean(logit_spoof − logit_bonafide), where index 0 = spoof.
- **Latency budget** (p95 on the VM): CM ≤ 2.5 s, ASV ≤ 0.3 s, STT ≤ 2 s, total ≤ 4 s after upload. Stage events (transcribing → anti-spoof → speaker → spectral) stream over `/ws/live`.
- **Expo acoustics:**
  - The recorder pins the input whose label contains `VOICE_MIC_LABEL`, shows the mic name, and refuses any other input.
  - It records a fixed **6.0 s** window with a visible countdown; there's no VAD end-pointing.
  - **Phrase check:** the best-aligned 5-word window of the transcript must match at least 4 of the 5 words after normalization. Extra bystander words are ignored.
  - **Onset:** the first VAD segment within 10 dB of the loudest segment (the close talker). Allowed range: 0.0–6.0 s.
  - **Sun 06:30 at the expo table:**
    - A records 5 more enrollment phrases, and ASV takes the max cosine over the quiet and expo centroids.
    - Run 10 A, 10 B and 10 clone trials, then set `T_ASV_HIGH = A's min − 0.03` and `T_CM = midpoint(A's max, clone's min)`.
    - Save the result to `data/calibration/expo.json`.
- **The DSP/FFT analysis is P0 and never cut.**
  - Input: STFT (n_fft = 512, hop = 160) → 64-band log mel LTAS, MFCC-20 mean/std, spectral centroid/rolloff/flatness, HF-energy ratio above 4 kHz (0–7.2 kHz guard), F0 median.
  - `spec_sim` = cosine([LTAS ‖ MFCC-mean], `profile.spectral_summary`).
  - It also produces human-readable `findings[]`, such as "energy 4–8 kHz −9 dB vs your profile".
- **Confidence:** `voice_confidence = clip(0.6·asv_norm + 0.25·(1−cm_p_spoof) + 0.15·spec_sim, 0, 1)`.
- **CM serialization:** one dedicated executor with `torch.set_num_threads(6)`, serialized by a lock. Target: under 1.5 s for the CM and under 6 s end to end.
- **Decision precedence**, where spoof detection always wins and is checked regardless of timing or words:
  1. VAD speech under 1.0 s → RETRY.
  2. `cm_p_spoof ≥ T_CM` → **BLOCK_SPOOF**.
  3. Phrase check fails (fewer than 4/5 words) → RETRY. This catches replays.
  4. `asv_cos ≤ T_ASV_LOW` → **BLOCK_IMPOSTOR**.
  5. Onset outside the allowed range → RETRY.
  6. `asv_cos ≥ T_ASV_HIGH` and `spec_sim ≥ T_SPEC` → **VERIFY**.
  7. Anything else → FALLBACK_MFA (TOTP).

  RETRY on attempt 3 becomes FALLBACK_MFA. Gray-zone results never lock the owner (§5.4).
- **Side effects:** delete the audio after scoring. Call `challenge_status` and `voice_decided`, and return `{result, outcome, next?}`.
- **Enrollment:** 5 phrases (20–30 s net) on the **demo USB mic**, storing the centroid, utterance embeddings and spectral summary. Reject if intra-cosine is below about 0.5.
- **Startup:** preload the models and run a warm-up before `/healthz` reports ok.

**C2.7 — Live attack tool (P0 by CP3).** `hearsay redteam attack --voice-id $ELEVENLABS_REDTEAM_VOICE_A --api https://2bme.tech --admin-token …` runs on B's laptop.
- It long-polls `/api/demo/redteam/active-challenge` (admin token; every read is logged as anomaly kind `redteam_tool`).
- As soon as a challenge appears, it pre-synthesizes the phrase with `eleven_flash_v2_5` (pcm_16000) in A's clone voice.
- It waits for status `prompt_ended`, sleeps 0.6 s, then plays the audio with `afplay`, either acoustically or through BlackHole per the C0.5 decision. Manual Enter is the fallback.
- `--mode tts|sts|premade|replay` selects the attack class.
- **Narration:** "this simulates an automated attacker whose clone pipeline reads the phrase off the screen; liveness timing can't stop it, so the countermeasure must."

**C3 — Web voice (P0).**
- **`<VoiceRecorder/>`:**
  - Create the AudioContext at the **native rate**, with no sampleRate option; that avoids aliasing and Firefox rate errors.
  - `getUserMedia({audio:{deviceId: pinned, channelCount:1, echoCancellation:false, noiseSuppression:false, autoGainControl:false}})`.
  - An AudioWorklet in `web/public/worklets` packs the Float32 frames into a native-rate PCM16 WAV. **The server resamples** it.
  - Enrollment, the red-team corpus and challenges all use the same path.
- **`<ChallengeFlow challengeId onDone={({result, outcome}) => …}/>` never autoplays.**
  - It renders one big **Start voice check** button. That single click gesture runs `ctx.resume()`, `getUserMedia` and `prompt.play()`, so the mic is open and the worklet is running before the prompt plays.
  - If `play()` rejects, it shows the phrase text and a **Speak now** button instead.
  - It keeps samples from the prompt's `ended` timestamp and sends that offset as `client_prompt_end_ms`.
  - It calls `POST /voice/challenges/{id}/prompt-ended`, beeps and shows a red REC ring.
  - It shows the stages (transcribing → anti-spoof → speaker → spectral) and handles `next`.
  - `<LiveSpectrum/>` draws an AnalyserNode FFT while the user speaks.
  - `<SpectrogramView/>` shows the reply next to the enrolled LTAS.
  - `<VoiceEnroll onDone/>`.
- **Pages:**
  - `/verify?c=` handles proactive and unlock challenges.
  - `/shop` is the "2bME Demo Store":
    - one $2,000 item, a prefilled **read-only** test PAN 4111 1111 1111 1111, and a persistent banner "DEMO – no real payment, not affiliated with Visa";
    - no Visa or card-network logos or marks; the result card reads "3-D Secure-style result: Y/C/N (simulated)";
    - a binding badge showing device name · heartbeat age · live confidence (red when there's no binding or the heartbeat is stale);
    - Y shows the confidence and binding;
    - C opens ChallengeFlow in a modal and renders `outcome.resolved_decisions` as Y or N;
    - N shows the reason;
    - a tier × confidence policy matrix sits beside it.

**C4 — Red team. C4-lite is P0 by CP4; the team head is P2.**
- **Clips:**
  - one clone (A): 20 phrases × {flash TTS, multilingual_v2 TTS, `eleven_multilingual_sts_v2` STS from B's voice} = 60 clips;
  - 20 replays of A's old takes;
  - 20 genuine phrases each from A and B.
- `scripts/voice_channel_match.py` plays the attack clips through the chosen delivery path into the demo mic, unattended.
- **Outputs:** FAR per attack class (ASV-only, CM-only, fused), FRR, the calibrated `VOICE_T_*` values, and `reports/redteam.json`.
- All of these runs use the `redteam` trigger, so they have no lock effects.

**C5 — Hearsay model.** C5-lite is **P0 for Hearsay, done by 18:00**; C5-train is P1.
- **Data:**
  - **Synthetic:** DiffSSD `generated_speech.tar` (18.1 GB, synthetic only), downloaded and extracted **on the batch box**.
  - **Real:** LJ Speech 1.1 **plus** LibriSpeech dev/test clean/other, all resampled to 16 kHz.
  - `manifest.parquet` columns: path, label, generator, source_corpus, speaker, text_id, split, dur.
  - **Confound check:** false-alarm rate on LJ-real vs Libri-real. If they differ by more than 2×, rebalance.
- **Data rules:**
  - No fingerprinting or hash-matching of test files.
  - Train only on DiffSSD `train`, tune on `val` and `hearsay_dev`, and never use DiffSSD `test` unless the organizers approve in writing (record it in `RULES.md`).
  - GroupKFold by generator/speaker, with a text-disjointness assertion.
  - Test WAVs never fit anything.
- **Test-condition simulator:** the same seeded distribution for both classes.
  - Stretch: none, phase vocoder, `ffmpeg atempo`, or resample-speed, with r in [0.85, 1.15].
  - Noise and room tone at 5–30 dB SNR.
  - A randomly chosen resampler, and gain ±6 dB.
- **Silence:** analyzers run on raw and VAD-trimmed audio and pick the better on dev. `silence.py` is documented as a dataset-artifact analyzer.
- **C5-lite (P0 for Hearsay):**
  - Rank-normalize DF_Arena_500M (K = 3 evenly spaced windows) and one second pretrained detector (dev-gated).
  - Fuse by mean rank or a "conservative AND" (the min of the top 2 ranks), choosing on `hearsay_dev`.
  - Output TSV v2.
- **C5-train (P1):**
  - `ssl_lr`: an L2 logistic regression on cached layer embeddings.
  - `DF_Arena_1B_V_1` (GPU only).
  - Stacked fusion.
  - A ranking-safe orchestrator: a uniform base plan, at most 3 condition-bucket experts that output LLRs on one scale, an escalation band, and each rule kept only if dev minDCF improves.
  - Extra analyzers with standalone dev rows: phase / group delay, bispectrum, bandwidth, formants, and a layer probe.
  - **Ship only if it beats C5-lite by 0.01 or more on the mean dev minDCF.**

**C6 — Hearsay packaging (P0 for Hearsay).**
- **Image:** build on the **amd64 batch box** (or `buildx --platform linux/amd64`).
  - `FROM python:3.12-slim` with ffmpeg and libsndfile1, CPU torch, and only `hearsay[detect]`.
  - At build time: `snapshot_download` of every detector plus the `wav2vec2-xls-r-300m` config, then `python -m hearsay selftest` (populates the remote-code cache and asserts direction).
  - `ENV HF_HOME=/models/hf HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1`.
  - Entrypoint: `python -m hearsay predict /data --template … -o /out/<TEAM>_predictions.tsv`.
- **`scripts/voice_release_check.sh`:** run with `--network none`; require Spearman ρ ≥ 0.999 against the submitted TSV; record wall time. Push to GHCR tagged with the SHA.
- **Root `README.md`** opens with a Hearsay judge box (README, TSV, image and a one-line `docker run`).
- **`hearsay_submission/README.md` sections:**
  1. TL;DR metrics
  2. Quickstart and runtime
  3. Architecture
  4. Forensic techniques table by family (learned SSL, magnitude spectrum, phase, higher-order, prosody, silence, condition profiling) with a standalone dev score each
  5. Orchestration and trace
  6. Data and leakage controls
  7. Results: ablation, DET, per-generator and per-condition breakdowns, and the 10 hardest real clips
  8. Score semantics
  9. How to reproduce
  10. Limitations and licenses (DF_Arena non-commercial, DiffSSD NC-ND, parselmouth GPL)
  11. How it powers the 2bME step-up
  12. AI and agent tooling used

**C7 — P1: forensic analyst agent (`hearsay/agent.py`).**
- It is a tool-calling LLM using the Vultr Serverless Inference model if it supports tools (VERIFY), otherwise the Claude API.
- Tools: `profile_audio`, `run_analyzer`, `analyzer_reliability`, `similar_dev_cases`, `spectrogram_png`.
- It writes a JSON report and **never changes a score**.
- Uses: README case reports, async step-up `findings`, and dev error analysis that proposes rules, which dev ablation then accepts or rejects.

## 9. Timeline (ET), tripwires and cut lines
| When | Claude | Codex 1 | Codex 2 | Humans |
|---|---|---|---|---|
| **Sat 00:45–02:30** | A0 contracts → **CP0 02:30** | B0 probe → **B0.5 recorder on A's laptop by 01:45** | C0 package locally, then on the batch box at about 01:30; DF_Arena fallback decided at 02:15 | **B:** VM + batch box + firewall + DNS + Caddy/mictest + Tiger extension check + IVC plan check + deploy key. **A:** Hearsay PDF, test set and RULES; Input Monitoring; consent forms (01:30); start recorder 01:45. **02:05–02:20 swap session 0** (B on A's laptop, `--label impostor --actor b`) |
| 02:30–06:30 | A1 hub/WS/auth/policy + A2 hypertables → deploy walking skeleton | B2 features on night logs; B3 v0 `--from-logs`; night EER by 05:30 | C1 safety TSV by 05:00; **C0.5 spoof test 03:00–04:30 with A**; C1b harvest; C1c dev set; C2 core | **B sleeps 02:30–06:30.** A works normally with the recorder on (≥3 h of natural enrollment) and supervises from queue files |
| **CP1 06:30** | walking skeleton on https://2bme.tech: fixture replay → wss → dashboard → stub challenge → /verify uploads WAV → /shop Y/C/N | night EER table; agent streams live | safety TSV (submitted if a path exists); attack-delivery decision; T_CM v0 | A writes queue files |
| 06:30–10:30 | real scorer on VM; dashboard, login | B1 live + B4 + monitor on model v0; replay backfills night logs into Tiger | C2 real on VM; C3 components; /verify, /shop; C5-lite start; Hearsay image v0 | **A sleeps 06:30–10:30**; B supervises and merges via gate |
| **CP2 10:30** | live trust from A's laptop on 2bme.tech | model v1 live; /enroll page | voice live on VM | 10:30–11:30: A does 20 min of structured enrollment **on the demo tasks** → v2; voice enroll A and B on the USB mic; TOTP enroll; swap session 1 (10 min) |
| **CP3 14:00 VERTICAL SLICE** | agent → Vultr → live trust → takeover → proactive challenge → voice VERIFY/BLOCK_* → shop Y/C/N (+ remote-cookie C) | | attack tool works | 14:00–14:45 acceptance: 5 takeover trials + 15 voice trials; A stays in monitor all afternoon (genuine FA/h test) |
| 14:00–19:00 | landing, /history-min, /lab-min, expo reset/re-arm, TOTP, A5 explain | B5-min, B7-min, presence | C4-lite, C5-lite → TSV v2 by 18:00, C6 packaging | 15:00 swap session 2; 15:30 red-team recordings (quiet room) |
| **CP4 19:00 FEATURE COMPLETE** | thresholds and tuned config promoted | reports/eval.json | reports/redteam.json + hearsay.json; image pushed | 19:30 rehearsal #1 (outside the Atrium) |
| 19:00–23:30 | polish, VM snapshot | replay lane; pre-cut items only if green | Hearsay submission complete; C5-train/C7 only if green | Devpost draft; 23:00 backup video |
| **Sat 23:30 FEATURE FREEZE** | fixes only | | | rehearsal #2; **Devpost submitted (editable)**; Hearsay final submitted (an earlier official deadline overrides) |
| Sun 00:00–03:00 | | | | **B sleeps**; A supervises |
| 03:00–06:30 | | | | **A sleeps**; B supervises, takes snapshots |
| 06:30–07:30 | | | | Atrium: A does a 10-min enrollment top-up **standing at the expo table** → Retrain now → tag `demo-final` by 06:45, then `CONTINUOUS_UPDATE=false`; expo voice calibration (§8 C2) + clone gate; `doctor --stage` |
| **07:30 DEMO FREEZE** | snapshot, tag `demo` | | | final Devpost edit; confirm Hearsay |
| **08:00 HARD STOP** | | | | expo 09:30–11:00, Klaus Atrium; **no deploys 09:00–11:30** |

**Tripwires:**
- **06:30:** if keyboard and mouse night EER are both above 35%, Codex 1 drops everything except features and model.
- **11:30:** if model v2 isn't live on 2bme.tech, all P1 work freezes.
- **15:00:** if CP3 isn't green, cancel C4 beyond calibration, C5-lite improvements and B7; everyone works on CP3.
- **19:00:** unfinished work gets cut, not continued.

**Cut order** (the pre-cut list in §0.2 goes first):
1. drift_30m
2. A5 explanations
3. C5-lite second detector (keep zero-shot)
4. landing live dots (keep static)
5. B7 quarantine niceties (keep Retrain now)

**Never cut:** the §0.1 MVP.

## 10. Human protocol (2 people)
**Roles:**
- **A (owner):** the enrolled user and demo-laptop owner. Supervises Codex 1, is the consented clone subject, and handles the Hearsay rules.
- **B (attacker/ops):** the impostor. Supervises Claude and Codex 2, owns the VM, the batch box (provisioning, downloads, tmux jobs, a cost check at every checkpoint) and the accounts.

**Sleep:**
- B sleeps Sat 02:30–06:30 and Sun 00:00–03:00.
- A sleeps Sat 06:30–10:30 and Sun 03:00–06:30.
- A sleeps last before the expo and does the top-up rested, in the same state as the demo.

**Data rules:**
- B toggles **"Impostor at keyboard"** on the observer screen (or presses ⌃⌥⌘M during rehearsals) **before** touching A's laptop, and toggles it back after leaving.
- Only A uses A's laptop otherwise.
- Enroll with the same trackpad and keyboard used on stage.
- **Demo-context enrollment:** at least 15 of A's structured-enrollment minutes are the demo choreography itself (browse the shop, type a shipping address and gift note, check out, scroll the dashboard), done **standing** at a table-height laptop.
- **Attacker task,** rehearsed at least 10 times (about 150 keystrokes and 15 mouse actions in 45 s): open checkout, change the shipping address, type a 2-sentence gift note, open 2 product pages, return to the cart. If median TTD exceeds 45 s, lean the task toward B's most discriminative modality (from the B5 per-modality EER).
- **One USB desk mic** for all voice enrollment, challenges, red-team channel matching and the expo.
- **Judges at the table:**
  - They may play attacker on the **behavior side only**, in an `ephemeral` impostor-labeled session that is never written to training.
  - We **never clone a judge's or bystander's voice**. The only clones are A's and B's, with written consent.
  - Judges can try their own voice in the `/lab` voice sandbox, which has no effects.

**Consent:** A and B sign written consent for cloning (`data/consent/`). Delete the clones after the event.

**After the event:** revoke Input Monitoring, delete `~/.2bme/logs`, delete the IVC voices and destroy the batch box.

**Optional fresh-attacker trial:** only if you choose it, and for testing only. Volunteers use A's laptop for 60 s in an impostor-labeled session, their TTD is recorded, then the session is purged with `/demo/purge-session`. This never feeds training or calibration, so it respects the teammates-only decision.

## 11. Verification
### 11.1 Day-1 smoke tests (`ops/SMOKE.md`, pass/fail)
- **Tiger:** `SELECT extname, extversion FROM pg_extension` shows timescaledb ≥ 2.20, with vector and vectorscale installable. Also confirm the toolkit, the hypertable DDL and the auto columnstore policy.
- **Agent:** `twobme-agent doctor`.
- **Voice models:** DF_Arena and ECAPA load on the batch box and the VM; record ms per window.
- **ElevenLabs:** `GET /v1/models` includes `eleven_flash_v2_5` and `scribe_v2`; IVC is on the plan; `pcm_16000` output is allowed.
- **Vultr inference:** `GET /v1/models`; pin the model id.
- **Domain and mic:**
  - `dig` resolves, the Caddy certificate is issued, and **getUserMedia works on https://2bme.tech/mictest**.
  - Chrome site settings show Microphone = Allow (not "this time"), and macOS Privacy & Security > Microphone enables Chrome.
- **Tiger jobs:** `timescaledb_information.jobs` shows the columnstore jobs at 15 min.
- **ElevenLabs quota:** `GET /v1/user/subscription` is shown in `/status` and turns amber at 80%.
- **Hearsay:** `RULES.md` answered.

### 11.2 Automated tests
- **Codex 1:** features (fixtures, properties, signature coverage), trust properties (§7 B4) and TS↔Python parity.
- **Codex 2:**
  - minDCF matches the ASVspoof5 evaluation-package output;
  - the TSV writer preserves the template;
  - the direction test;
  - VAD on silence → RETRY;
  - decision precedence: spoof beats RETRY.
- **Claude:**
  - policy and lock state machine: no deadlock, unlock only via voice or reset, behavior never blocks;
  - decision resolution;
  - session resume never re-anchors: kill and reconnect the WS mid-impostor replay, and confidence afterwards is ≤ before;
  - markers never reach the scorer or TrustEngine;
  - an attacker-created order stays N after the owner's later VERIFY;
  - degraded mode: with Tiger unreachable, login, decisions and voice still work;
  - co-presence (remote cookie → 0.30 → C).
- **`core_e2e_local.sh`:**
  1. Bring up the dev compose stack and run migrations.
  2. `agent replay` of `genuine_A`, then `impostor_B`.
  3. Assert that trust events arrive, rows land, the level reaches suspicious and a proactive challenge is issued.
  4. The stub voice returns BLOCK_IMPOSTOR → the device locks and `/checkout` returns N.
  5. An unlock challenge with VERIFY → Y.

### 11.3 Live acceptance (CP3/CP4 gates)
- **Genuine:** A over 30 min stays ≥ 0.80 on at least 95% of ticks, with 0 locks.
- **Detection:** median TTD(0.40) ≤ 60 s over 5 trials.
- **Checkout:**
  - B's purchase within 15 s of takeover returns C, never N, on 5/5 attempts;
  - the remote-cookie purchase returns C at 30%.
- **Voice:**
  - A VERIFY 5/5
  - B BLOCK_IMPOSTOR 5/5
  - A's clone BLOCK_SPOOF ≥ 4/5
  - replay → RETRY
- **Latency:** step-up round trip < 8 s.
- **Hearsay:** dev minDCF_a/b reported in the README; the release check passes.

## 12. Deferred: Backboard.io
The user deprioritized it. Keep only the `ContextStore` protocol (`record(user_id, kind, text)`, `recall(user_id, query)`) with `NoopContextStore`. A future `BackboardContextStore` would:
- call `https://app.backboard.io/api` with an `X-API-Key` header, using one assistant per user;
- **always pass the memory mode explicitly**;
- store only categories and hashed IDs, never plaintext app names;
- run off the hot path.

## 13. Demo
**Expo mode (P0 by CP4):**
- **Reset demo** (a dashboard button or ⌃⌥⌘R) completes in 5 s or less.
- **Re-arm (31%)** sets up a repeatable attack beat.
- A **60 s replay lane**, `twobme-agent replay` of a recorded takeover, is there for rushed judges or a live failure.

**Core run: target 2:45, hard cap 3:30.** Judges rotate every 3–4 min, so expect 10–20 runs between 09:30 and 11:00. The topology is in §2.3.

| Time | What happens |
|---|---|
| **0:00** | Observer: "Login proves who you *were*; 2bME keeps checking who you *are*." A is working live at 97–99%, and the "What left this laptop" drawer shows the last block sent. |
| **0:20** | A, hands on the laptop, buys the $2,000 item → **Y (frictionless)**, next to the tier × confidence matrix. |
| **0:40** | A steps back and presses **Mark takeover** on the observer screen. B runs the rehearsed attacker task (§10). |
| **0:40–1:25** | Trust falls live: modality bars turn red, why-chips appear ("flight time +3.1σ"), the TTD stopwatch freezes at "Detected in 38 s", and the feed shows "challenge armed". Narrate the actual confidence; don't fake 31%. |
| **1:30** | B clicks Pay → **C, step-up**. B presses Start voice check, the prompt plays, and the attack tool plays **A's ElevenLabs clone** of the fresh phrase. Stages: Words ✓ · Speaker 0.58 (would pass alone, if measured) · Synthetic 0.93 ✗ → **BLOCK_SPOOF**, order **N**, device locked. Spectrogram, FFT and DSP findings shown. |
| **2:10** | A returns, logs in, and unlocks with voice on a new phrase → **VERIFY**, 97%. **The attacker's order stays declined.** A places their own order → **Y**. |
| **2:40** | Close on the anomaly row with the Vultr-generated explanation, plus one number chosen for this judge. |

**Deep dives, 45 s or less, chosen per judge:**
- **Tiger:** `/history` timeline and anomalies, compression (`compress-now`), and "the identity model updated itself v1→v7".
- **NSA:** the `/lab` voice sandbox. B's own voice → BLOCK_IMPOSTOR, and the judge can try theirs. Also Hearsay minDCF and the orchestrator trace.
- **ElevenLabs:** FAR per attack class.
- **Identity evidence:** A-vs-B EER, branch ablation and the identification matrix.
- **Visa:** tier matrix, 3DS-style Y/C/N, and the remote-cookie variant (B's laptop with A's cookie → "remote session, 30%" → C).
- **Vultr:** `/status` plus the explanation.
- **.tech:** the live site.

**60 s crowd version:** gauge → takeover → drop → Pay → clone blocked.

**Between runs, 20 s or less:** the observer presses Reset demo, and A works for 30 s.

**Abort rules:**
- Never click Pay below 0.95 (A's order).
- If TTD passes 75 s, keep narrating.
- If voice errors twice, use TOTP.
- If the agent or network fails, switch to the replay lane and **say it's a replay**.

**Clone gate, at CP4 and again Sun 06:30:** 10 over-the-air trials in the expo setup.
- If BLOCK_SPOOF succeeds fewer than 8/10 times, run the clone beat as a recorded run plus the red-team table, and use B's own voice (BLOCK_IMPOSTOR) live.
- If ASV ≥ T_high in fewer than 5/10 clone trials, don't claim "the speaker check was fooled". Say it was borderline and the deepfake detector was decisive.

**Fallbacks:**
- **Live capture fails:** the replay lane, said out loud.
- **Network:**
  - The primary network is the **phone hotspot**; venue Wi-Fi is the backup.
  - `scripts/demo_offline.sh` (P1, rehearsed at CP4) starts the dev compose on the laptop with `data/` synced from the VM: models, voice profiles, prompt pool and seed users.
  - It sets `STT_BACKEND=local`, serves `https://localhost` (a secure context for the mic), and repoints the agent with `--api https://localhost`.
- **ElevenLabs fails:** the cached prompt pool plus faster-whisper, or the backup key.
- **Tiger fails:** degraded mode (§6 A1).
- **Last resort:** the backup video (recorded Sat 23:00), looping on the tablet.

## 14. Submission checklist
- **Devpost:** description, video, repo link and the sponsor tracks:
  - MLH Best Use of ElevenLabs, Tiger Data, Vultr and .tech domain;
  - NSA Hearsay;
  - optionally VISA Reimagine Shopping, since the mock checkout already exists.
- **expo.hexlabs.org:** the Devpost link.
- **Hearsay:** the TSV through the official path, the image on GHCR, the repo, and `hearsay_submission/README.md`.
- **Repo:** public; README with the architecture, privacy promise and judge boxes; no secrets (run `gitleaks` or a grep before making it public).
