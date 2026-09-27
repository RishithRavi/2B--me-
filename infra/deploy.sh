#!/usr/bin/env bash
# Deploy on the VM (§6 A4):  cd /opt/2bme && infra/deploy.sh [--no-pull] [--rebuild-base] [--skip-web]
#   1. git pull --ff-only                        (unless --no-pull)
#   2. build twobme-base only when uv.lock changed (tagged by lock hash)
#   3. build the web inside node:22 (never the VM's own node)  (unless --skip-web, e.g. after rsyncing web/out)
#   4. docker compose up -d (api image = base + code, seconds)
#   5. wait for /api/status, then print /api/healthz (voice warm-up can take a few minutes)
# Guards: no deploys Sun 09:00–11:30 ET (FORCE_DEPLOY=1 to override); run one `sandbox` challenge after.
set -euo pipefail
cd "$(dirname "$0")/.."

PULL=1; REBUILD_BASE=0; WEB=1
for a in "$@"; do
  case "$a" in
    --no-pull) PULL=0 ;;
    --rebuild-base) REBUILD_BASE=1 ;;
    --skip-web) WEB=0 ;;
    *) echo "unknown arg $a"; exit 2 ;;
  esac
done

now=$(TZ=America/New_York date +%a%H%M)
day=${now:0:3}; hm=${now:3:4}
if [ "$day" = "Sun" ] && [ "$hm" -ge 0900 ] && [ "$hm" -lt 1130 ] && [ "${FORCE_DEPLOY:-0}" != "1" ]; then
  echo "No deploys Sun 09:00–11:30 ET (expo). FORCE_DEPLOY=1 to override."; exit 1
fi
[ -f .env ] || { echo ".env missing (copy .env.example and fill it)"; exit 1; }
mkdir -p data reports
export UV_EXTRAS="${UV_EXTRAS:-}"

if [ "$PULL" = 1 ]; then git pull --ff-only; fi
echo "deploying $(git rev-parse --short HEAD)"

lock=$( { sha256sum uv.lock; printf '%s\n' "$UV_EXTRAS"; } | sha256sum | cut -c1-12)
if [ "$REBUILD_BASE" = 1 ] || ! docker image inspect "twobme-base:$lock" >/dev/null 2>&1; then
  echo "building twobme-base:$lock (dependency lock or extras changed)…"
  docker build --build-arg UV_EXTRAS="$UV_EXTRAS" \
    -f infra/Dockerfile.base -t "twobme-base:$lock" -t twobme-base:latest .
else
  docker tag "twobme-base:$lock" twobme-base:latest
fi

if [ "$WEB" = 1 ]; then
  echo "building web in node:22…"
  docker run --rm -v "$PWD/web:/app" -w /app -e NEXT_TELEMETRY_DISABLED=1 -e CI=1 node:22 \
    sh -c "corepack enable && pnpm install --frozen-lockfile && pnpm build"
fi
[ -f web/out/index.html ] || { echo "web/out missing"; exit 1; }

COMPOSE=(docker compose --env-file .env -f infra/docker-compose.yml)
"${COMPOSE[@]}" build api
"${COMPOSE[@]}" up -d

echo -n "waiting for api"
for _ in $(seq 1 120); do
  if "${COMPOSE[@]}" exec -T api curl -fsS http://localhost:8000/api/status >/dev/null 2>&1; then echo " up"; break; fi
  echo -n "."; sleep 2
done
"${COMPOSE[@]}" exec -T api curl -sS http://localhost:8000/api/status; echo
"${COMPOSE[@]}" exec -T api curl -sS http://localhost:8000/api/healthz; echo
echo "Reminder: after an API restart run one sandbox challenge before the next judge."
