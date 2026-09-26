#!/usr/bin/env bash
# §11.2 end-to-end on this machine: dev TimescaleDB (docker) + uvicorn + the synthetic replayer.
#   1. bring up infra/docker-compose.dev.yml (db) and wait for it; the API runs migrations on start
#   2. start uvicorn on a free port with a throwaway DATA_DIR
#   3. scripts/core_replay_ticks.py --e2e: enroll → train from Tiger → genuine → takeover → suspicious →
#      proactive challenge → C → stub BLOCK_IMPOSTOR → lock → N → unlock VERIFY → co-present Y
# When Codex 1's fixtures + `twobme-agent replay` land, step 3 also replays genuine_A then impostor_B.
# MODEL_BACKEND defaults to `fallback` here: the fast synthetic run enrolls 40 ticks, below twobme_ml's gates.
# `MODEL_BACKEND=auto scripts/core_e2e_local.sh` must pass too (twobme_ml refuses → that job trains the
# fallback model and the identity card says so).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

PORT="${E2E_PORT:-8765}"
DB_URL="${E2E_DB_URL:-postgres://postgres:postgres@localhost:5433/tsdb_e2e}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/twobme-e2e.XXXXXX")"
LOG="$TMP/api.log"
PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

docker compose -f infra/docker-compose.dev.yml up -d db >/dev/null
for _ in $(seq 1 60); do
  docker compose -f infra/docker-compose.dev.yml exec -T db pg_isready -U postgres -d tsdb >/dev/null 2>&1 && break
  sleep 1
done
if [ -z "${E2E_DB_URL:-}" ]; then  # fresh database every run (no cross-run training contamination)
  docker compose -f infra/docker-compose.dev.yml exec -T db psql -U postgres -d postgres -qc "DROP DATABASE IF EXISTS tsdb_e2e WITH (FORCE)" >/dev/null
  docker compose -f infra/docker-compose.dev.yml exec -T db psql -U postgres -d postgres -qc "CREATE DATABASE tsdb_e2e" >/dev/null
fi

export TIGER_DATABASE_URL="$DB_URL" DATA_DIR="$TMP/data" REPORTS_DIR="$TMP/reports" COOKIE_SECURE=false \
       DEMO_MODE=true ADMIN_TOKEN="e2e-admin" SEED_PASSWORD_A="e2e-a" SEED_PASSWORD_B="e2e-b" \
       SEED_PASSWORD_ADMIN="e2e-admin-pw" DECISION_TICK_WAIT_S=0.2 WRITER_FLUSH_S=0.5 \
       MODEL_BACKEND="${MODEL_BACKEND:-fallback}"
echo "e2e: MODEL_BACKEND=$MODEL_BACKEND port=$PORT db=${DB_URL##*/}"
uv run uvicorn app.main:app --app-dir server --port "$PORT" --log-level warning >"$LOG" 2>&1 &
PID=$!
for _ in $(seq 1 60); do
  curl -fsS "http://localhost:$PORT/api/status" >/dev/null 2>&1 && break
  sleep 0.5
done
if ! curl -fsS "http://localhost:$PORT/api/status" | grep -q '"tiger":"up"'; then
  echo "API did not come up with Tiger:"; tail -40 "$LOG"; exit 1
fi

set +e
uv run python scripts/core_replay_ticks.py --e2e --api "http://localhost:$PORT" \
  --password "e2e-a" --admin-token "e2e-admin"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then echo "--- api log (tail) ---"; tail -60 "$LOG"; fi
exit "$rc"
