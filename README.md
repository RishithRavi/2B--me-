# 2bME — continuous behavioral identity

> Login proves who you *were*. 2bME keeps checking who you *are*.

Deployment target: **https://2bme.tech** on Vultr · HackGT 13

<!-- HEARSAY JUDGE BOX (Codex 2 fills in at C6):
| NSA Hearsay | |
|---|---|
| README | hearsay_submission/README.md |
| Predictions TSV | hearsay_submission/predictions/<TEAM>_predictions.tsv |
| Image | ghcr.io/<org>/2bme-hearsay:<sha> |
| Run | `docker run --rm --network none -v $PWD/test:/data -v $PWD/out:/out ghcr.io/...` |
-->

## What it does
A macOS agent turns keyboard, trackpad, scroll and app-switching **timing** into privacy-safe aggregate
blocks, streams them to a FastAPI scorer designed for Vultr Compute, and keeps a **continuous trust
score** for the enrolled person. When someone else takes over the session, trust falls, and a high-risk action (a $2,000
checkout) steps up to a **voice challenge**. ElevenLabs speaks a fresh phrase, and FFT/DSP features, a
speaker embedding and a deepfake detector decide VERIFY / BLOCK_IMPOSTOR / BLOCK_SPOOF. Behavior alone
never blocks. On the laptop itself, an always-on-top overlay shows live trust and takes over the screen
with the voice check when someone else seems to be at the keyboard; a failed check locks the Mac.
Tiger Data stores the behavior history, baselines and anomalies.

For a security team, `/admin` gives org-wide visibility: a roster of employee sessions, insider-threat
and anomaly surfacing across the org, and an audit trail of trust changes, alerts and challenges — the
same continuous-identity signal, aggregated instead of per-person.

```
agent (PyObjC tap → key classes → evidence blocks) ──wss──▶ FastAPI hub (Vultr target) ──▶ TrustEngine ──▶ dashboard
                                                                 │                        │
                                                                 ├─▶ Tiger (hypertables, columnstore, caggs)
                                                                 └─▶ voice step-up (ElevenLabs prompt + STT, ECAPA, DF_Arena, DSP/FFT)
```

## Vultr integration

Vultr is a concrete deployment and inference integration in this repository, not a requirement for the
local demo:

- **Vultr Compute target:** `infra/docker-compose.yml`, `infra/Caddyfile` and `infra/deploy.sh` package
  the FastAPI hub, static web app and Tiger Data connection for a small Ubuntu VM behind HTTPS.
- **Vultr Serverless Inference:** `server/app/core/explain.py` uses Vultr's OpenAI-compatible endpoint
  to turn the trust change and five largest feature deviations into a short anomaly explanation. Raw
  keystrokes, audio and activity streams are never included in that request.
- **Graceful local fallback:** without `VULTR_SERVERLESS_INFERENCE_API_KEY` and
  `VULTR_INFERENCE_MODEL`, the same flow produces a deterministic template explanation. `/api/status`
  reports the active explanation backend as `vultr` or `template`.

The integration path is implemented and ready to configure; this README does not claim that the public
domain or the full production stack is currently live.

## Privacy promise
We never record typed content, passwords, clipboard, document text, window titles, URLs or key
identities. Keycodes are mapped to hand-level classes on the capture thread and dropped; only per-block
percentiles, rates and counts leave the laptop (see "What left this laptop" on the dashboard).
Enforced in CI by `scripts/check_privacy.sh`. Voice: *"Our server deletes challenge audio after scoring
and stores only embeddings and scores. ElevenLabs processes the prompt and STT audio and, on our plan,
retains it in account history (Zero Retention is enterprise-only). `STT_BACKEND=local` avoids this."*

## Repo map
| Path | What | Owner |
|---|---|---|
| `contracts/` | frozen contracts: feature spec, trust config, WS/REST docs, schemas, fixtures | Claude |
| `packages/common` | `twobme_common`: shared pydantic DTOs, spec loader, config | Claude |
| `server/` | FastAPI hub, policy, Tiger writer/history, auth | Claude (`server/app/voice`: Codex 2) |
| `web/` | Next.js static site (landing, dashboard, history, lab, shop, verify, enroll, overlay, admin) | Claude / Codex 1 / Codex 2 |
| `overlay/` | Electron on-laptop overlay: trust pill → full-screen voice check on a suspected takeover → lock screen | Claude |
| `infra/` | Docker Compose, Caddy, migrations, deploy | Claude |
| `agent/`, `packages/features`, `packages/ml` | macOS agent, feature extraction, models, TrustEngine | Codex 1 |
| `packages/hearsay`, `hearsay_submission/` | voice anti-spoof + NSA Hearsay submission | Codex 2 |

## Dev quickstart
```bash
uv sync --all-packages                                   # Python 3.12 workspace
docker compose -f infra/docker-compose.dev.yml up -d db  # local TimescaleDB-HA on :5433
TIGER_DATABASE_URL=postgres://postgres:postgres@localhost:5433/tsdb COOKIE_SECURE=false \
  uv run uvicorn app.main:app --app-dir server --port 8000
cd web && corepack pnpm i && corepack pnpm dev           # http://localhost:3000 (proxies /api to :8000)
scripts/gate.sh core                                     # merge gate
```
Contracts: edit `packages/common/src/twobme_common/types.py` or `contracts/*.yaml`, then
`uv run python scripts/core_gen_ts.py` (regenerates `web/src/lib/contracts.ts` + report schemas).

Sponsors: Tiger Data · Vultr · ElevenLabs · .tech · NSA Hearsay. The Visa-style checkout is a clearly
labelled demo scenario, not affiliated with Visa. `/admin`'s employee roster is synthetic, anonymized
demo data generated in the browser — no real person's behavior.
