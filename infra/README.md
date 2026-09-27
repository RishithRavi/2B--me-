# Deploy runbook (Vultr VM + Tiger Cloud + 2bme.tech)

## Step 0 — humans, hour 1 (no app code needed)
1. **VM:** Vultr `vhp-8c-16gb-amd` in `ewr` from the Docker marketplace image (app 1125). Firewall group: 22/tcp from
   team IPs, 80/tcp, 443/tcp, 443/udp.
2. **DNS** (.tech registrar): A records `@`, `www`, `app`, `api` → VM IP. Check: `dig +short 2bme.tech www.2bme.tech app.2bme.tech api.2bme.tech`.
3. **Code on the VM:** add a read-only deploy key to the GitHub repo, then
   `git clone git@github.com:RishithRavi/2B--me-.git /opt/2bme && cd /opt/2bme`.
4. **TLS + mic check** with the staging CA first:
   ```bash
   ACME_EMAIL=you@example.com ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory \
     docker compose -f infra/docker-compose.step0.yml up -d
   ```
   Open https://2bme.tech/mictest (accept the staging cert warning) → the meter moves → pass.
   Then `docker compose -f infra/docker-compose.step0.yml down` and continue (production CA is the default).
5. **Tiger Cloud** (us-east-1): create the service, copy the connection string with `?sslmode=require`.
   `tiger mcp install claude-code` / `tiger mcp install codex` for the coding agents (optional).

## `.env` on the VM
`cp .env.example .env` and set at least: `ACME_EMAIL`, `SESSION_SECRET` (`openssl rand -hex 32`), `ADMIN_TOKEN`
(`openssl rand -hex 16`), `SEED_PASSWORD_A/B/ADMIN`, `TIGER_DATABASE_URL`, `ELEVENLABS_*` (when voice lands),
`VULTR_SERVERLESS_INFERENCE_API_KEY` + `VULTR_INFERENCE_MODEL` (explanations; template fallback otherwise).
Never commit `.env`.

## Deploy
```bash
cd /opt/2bme && infra/deploy.sh          # pull, base image if uv.lock changed, web in node:22, compose up, health
infra/deploy.sh --skip-web               # after rsyncing a locally built web/out
infra/deploy.sh --rebuild-base           # force the dependency image
UV_EXTRAS="--extra voice" infra/deploy.sh --rebuild-base  # real voice dependencies
```
- Keep `UV_EXTRAS="--extra voice"` on later real-voice deploys so the exact API
  sync does not remove the model stack. Stub demo deploys leave it unset.
- The API runs migrations on start (idempotent). It starts even if Tiger is down (`/api/status` → `tiger:"down"`).
- `/api/healthz` is 200 only after the voice warm-up.
- For real voice, first resolve and copy the generated nonsecret pins into `.env`,
  then preload the exact models into the persistent `hf` volume:
  ```bash
  UV_EXTRAS="--extra voice" docker compose --env-file .env -f infra/docker-compose.yml run --rm api \
    python scripts/voice_resolve_revisions.py --model df-arena --runtime-root /app/data/voice-runtime
  # Copy VOICE_CM_MODEL, VOICE_CM_REVISION, VOICE_ECAPA_REVISION and
  # VOICE_CALIBRATION_PATH from data/voice-runtime/voice-runtime.env into .env.
  UV_EXTRAS="--extra voice" docker compose --env-file .env -f infra/docker-compose.yml run --rm api \
    sh -ec 'python scripts/voice_preload_models.py --model df-arena \
      --cm-revision "$VOICE_CM_REVISION" --ecapa-revision "$VOICE_ECAPA_REVISION" \
      --speaker-cache /app/data/models/ecapa \
      --output /app/data/voice-runtime/reports/model-preload.json'
  ```
  Real mode still requires the measured calibration JSON before `/api/healthz`
  can become ready. Keep `VOICE_MODE=stub` until preload and calibration pass.
- **No deploys Sun 09:00–11:30 ET.** After any API restart, run one `sandbox` challenge before the next judge.
- Snapshots: after the first end-to-end run and at demo freeze (Vultr console → Snapshots).

## Checks
```bash
curl -s https://2bme.tech/api/status | jq          # tiger up, writer, devices_online, inference backends
curl -s https://2bme.tech/api/tiger/stats | jq '.jobs'   # columnstore jobs every 15 min
docker compose --env-file .env -f infra/docker-compose.yml logs -f api
```
Walking skeleton without the real agent (from a laptop):
`uv run python scripts/core_replay_ticks.py --api https://2bme.tech --password "$SEED_PASSWORD_A" --schedule a:60,b:24`
then open https://2bme.tech/dashboard logged in as a@2bme.tech.

## Local
- `docker compose -f infra/docker-compose.dev.yml up -d db` → TimescaleDB-HA on :5433 (also the offline fallback).
- `scripts/core_e2e_local.sh` → the §11.2 scenario against a fresh local database (20 checks).

## Recovery
- API wedged: `docker compose --env-file .env -f infra/docker-compose.yml restart api` (trust state is persisted per tick
  to `data/state/registry.json` and Tiger; restored on start; > 10 min stale → 0.30).
- Tiger down: degraded mode (login, decisions, checkout, voice keep working; history shows cached payloads).
- Roll back a model: `POST /api/models/activate?user_id=…&version=N` with `X-Admin-Token`.
- Roll back code: `git checkout <tag> && infra/deploy.sh --no-pull`.
