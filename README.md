# 2bME — continuous behavioral identity

> Login proves who you *were*. 2bME keeps checking who you *are*.

Deploying to **https://2bme.tech** (not live yet) · HackGT 13

<!-- HEARSAY JUDGE BOX (Codex 2 fills in at C6):
| NSA Hearsay | |
|---|---|
| README | hearsay_submission/README.md |
| Predictions TSV | hearsay_submission/predictions/<TEAM>_predictions.tsv |
| Image | ghcr.io/<org>/2bme-hearsay:<sha> |
| Run | `docker run --rm --network none -v $PWD/test:/data -v $PWD/out:/out ghcr.io/...` |
-->

## What it does
Most security checks happen once, at login. 2bME keeps asking one question for the whole session:
**is the person at this keyboard still the enrolled owner?** It never tries to identify anyone. It is a
one-class, 1:1 check against a single person's own baseline, so it needs no database of other people.

1. **Enroll one person.** A macOS agent turns keyboard, trackpad, scroll and app-switching **timing** into
   privacy-safe aggregate blocks. The server learns a baseline from that one person's blocks.
2. **Continuous trust.** Every 5 s, fresh blocks are scored against the baseline and accumulated into a
   calibrated trust score, P(still the owner). A password never raises it.
3. **Risk-based step-up.** When trust falls below 40%, or a risky action needs more (a $2,000 checkout
   needs ≥ 90%), 2bME asks for an **independent factor**: a spoken random phrase checked for the words, the
   speaker and synthetic speech, or a TOTP code. **Behavior alone never blocks**; only that check can.
4. **Safe learning.** Only high-confidence genuine blocks (trust ≥ 95% over the last minute, no open or
   failed challenge) become update candidates, and blocks marked as a takeover never do. The loop is
   designed so an attacker can't teach the model their habits, but it isn't airtight yet: candidates from
   the minutes before an alert aren't revoked, and enroll-mode rows are trusted without evaluation
   (IMPLEMENTATION.md §7 B7). Retraining is operator-triggered ("Retrain now") and versioned; an
   automatic schedule is roadmap.

Tiger Data stores the behavior history, baselines, anomalies and the audit trail.

## Two UIs, two audiences
- **For individuals: the overlay** (`overlay/`, Electron). An always-on-top pill on the owner's Mac shows
  live trust. When a challenge arms, a full-screen voice check takes over ("Not now" is allowed, because
  behavior alone never blocks). A failed check signs the session out and shows a lock screen until the
  owner unlocks with a fresh phrase. The lock is the overlay plus session revocation, not an OS-level
  lock.
- **For small companies: the org console** (`/admin` on the site). A security admin sees every
  employee session: live trust, who is drifting, who is mid-challenge or locked, and an audit trail of
  trust changes, alerts, challenges and admin actions for tracing a breach back. The demo roster is
  **synthetic and anonymized** ("Employee NN"); no real person's behavior.
- The site also has the per-device dashboard (the admin's drill-in, and the stage view for the demo),
  `/history` (Tiger), `/lab` (the evidence) and the `/shop` checkout scenario.

## What is actually running (be honest in the pitch)
| Piece | Mode | How to tell |
|---|---|---|
| Behavioral model | `twobme_ml` (per-user one-class detector) when the package is installed; otherwise `fallback` (median/MAD distance to the baseline) | footer "model …", `GET /api/status` → `model_backend` (or `inference.model_backend`) |
| Where it runs | per user, one-class, but scored and trained **on the server** from Tiger history. On-device scoring is roadmap | — |
| Voice step-up | `VOICE_MODE=stub`: canned demo outcomes, labelled **"Voice: simulated (stub)"** in the site footer; never narrate them as a live analysis. `VOICE_MODE=real`: Hearsay VAD, anti-spoof (DF_Arena), ECAPA speaker match, DSP/FFT and speech-to-text, which needs pinned model revisions and a measured calibration | footer, `GET /api/status` → `voice_mode` |
| Anomaly explanations | a local template unless a Vultr Serverless Inference key is set | footer "explanations template/vultr" |
| Evidence (`/lab`) | real recordings of two teammates, and weak so far: fused A-vs-not-A EER 37.5% (AUC 0.78); mouse near chance; keyboard, workflow and temporal not measured yet; 0 of 5 live takeover trials. Not a blind test: not-A's blocks also fitted β and were used to choose the detector, so the EERs are optimistic. FAR/FRR at the 40% cut needs the splice replay (not run) | `reports/eval.json`, rendered at `/lab` |

The synthetic end-to-end test (`scripts/core_e2e_local.sh`) separates people by construction. It proves the
plumbing, never discrimination, so its numbers are never quoted as evidence.

```
agent (PyObjC tap → key classes → evidence blocks) ──wss──▶ FastAPI hub ──▶ TrustEngine ──▶ dashboard / overlay / org console
                                                               │                  │
                                                               ├─▶ Tiger (hypertables, columnstore, caggs, audit trail)
                                                               └─▶ voice step-up (prompt, STT, ECAPA, DF_Arena, DSP/FFT) or TOTP
```

## Privacy promise
We never record typed content, passwords, clipboard, document text, window titles, URLs or key
identities. Keycodes are mapped to hand-level classes on the capture thread and dropped; all digits
collapse into one class. Only per-block percentiles, rates and counts leave the laptop (see "What left
this laptop" on the dashboard). Mouse paths leave only as statistics normalized by the display; apps leave
only as a category. We send block aggregates rather than only risk events because baselines, retraining
and the org console need them. The merge gate (`scripts/check_privacy.sh`) fails if a window title, key
value, clipboard or bundle ID can reach a logger or transport.

Voice: *"Our server deletes challenge audio after scoring and stores only embeddings and scores.
ElevenLabs processes the prompt and STT audio and, on our plan, retains it in account history (Zero
Retention is enterprise-only). `STT_BACKEND=local` avoids this."*

## Repo map
| Path | What | Owner |
|---|---|---|
| `contracts/` | frozen contracts: feature spec, trust config, WS/REST docs, schemas, fixtures | Claude |
| `packages/common` | `twobme_common`: shared pydantic DTOs, spec loader, config | Claude |
| `server/` | FastAPI hub, policy, Tiger writer/history, auth, admin/org endpoints | Claude (`server/app/voice`: Codex 2) |
| `web/` | Next.js static site (landing, dashboard, history, lab, shop, verify, enroll, overlay, admin) | Claude / Codex 1 / Codex 2 |
| `overlay/` | Electron on-laptop overlay: trust pill → full-screen voice check → lock screen | Claude |
| `infra/` | Docker Compose, Caddy, migrations, deploy | Claude |
| `agent/`, `packages/features`, `packages/ml` | macOS agent, feature extraction, models, TrustEngine | Codex 1 |
| `packages/hearsay`, `hearsay_submission/` | voice anti-spoof + NSA Hearsay submission | Codex 2 |

## Dev quickstart
```bash
uv sync --all-packages                                   # Python 3.12 workspace
docker compose -f infra/docker-compose.dev.yml up -d db  # local TimescaleDB-HA on :5433
TIGER_DATABASE_URL=postgres://postgres:postgres@localhost:5433/tsdb COOKIE_SECURE=false DEMO_MODE=true \
  ADMIN_TOKEN=dev-admin SEED_PASSWORD_A=dev-a SEED_PASSWORD_B=dev-b SEED_PASSWORD_ADMIN=dev-admin-pw \
  uv run uvicorn app.main:app --app-dir server --port 8000
cd web && corepack pnpm i && corepack pnpm dev           # http://localhost:3000 (proxies /api to :8000)
scripts/gate.sh core                                     # merge gate
```
Contracts: edit `packages/common/src/twobme_common/types.py` or `contracts/*.yaml`, then
`uv run python scripts/core_gen_ts.py` (regenerates `web/src/lib/contracts.ts` + report schemas).

No backend? Every page has a clearly labelled simulated mode: add `?mock=1` (for example
`/dashboard?stage=1&mock=1`, `/admin?mock=1`, `/lab?mock=1`, which shows SAMPLE fixtures). The flag
sticks for the browser tab until a page is opened with `?mock=0`, so on the stage laptop open the live view
as `/dashboard?stage=1&mock=0` (the landing CTAs already do).

## Running the demo
- **Real agent** (A's Mac, Terminal.app with Input Monitoring): see `agent/README.md`
  (`twobme-agent pair --email a@…`, then `twobme-agent run --mode enroll|monitor`).
- **Overlay:** `cd overlay && corepack pnpm i && corepack pnpm start` (see `overlay/README.md`).
- **Stage replay** (a fake agent streaming hand-shaped aggregate ticks through the real hub and Tiger;
  always announce it as a replay):
  ```bash
  uv run python scripts/core_replay_ticks.py --api http://localhost:8000 --schedule a:24,b:12   # 2 min genuine, 1 min impostor
  ```
- **Org console demo** (seeds pseudonymous "Employee NN" users and devices through
  `POST /api/demo/org/seed`, then streams them through the real hub next to A's device):
  ```bash
  python scripts/core_org_demo.py --api http://localhost:8000 --admin-token "$ADMIN_TOKEN"
  ```
  Then open `/admin` as `admin@2bme.tech`. Without it, `/admin?mock=1` shows a seeded synthetic roster in
  the browser.

## Sponsors (only what is built)
- **Tiger Data:** behavior history, baselines, anomalies and the audit trail (hypertables, columnstore
  compression, continuous aggregates; `/history`, `/api/tiger/stats`).
- **Vultr:** hosting for the API and the behavioral model (deployment in progress). Explanations use a
  template until a Serverless Inference key is configured.
- **ElevenLabs:** spoken challenge prompts and speech-to-text in real voice mode, and synthetic voices for
  spoof testing.
- **.tech:** 2bme.tech, the site and the org console.
- **NSA Hearsay:** the voice anti-spoof layer of the step-up (see `hearsay_submission/`).
- **Visa:** the `/shop` 3DS-style Y/C/N checkout is a clearly labelled demo scenario, not affiliated with
  Visa.
- **Backboard:** roadmap (long-term contextual behavior history); not integrated.
