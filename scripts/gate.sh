#!/usr/bin/env bash
# Merge gate (§4). Claude merges a branch only when this passes on it.
#
#   scripts/gate.sh core|signals|voice|all      (default: all)
#
# Always: check_privacy.sh, contract tests, generated TS/schemas up to date.
# Per stream: that stream's tests (packages that don't exist yet are skipped, loudly).
# Web: typecheck + vitest when web/ has node_modules (CI-less hackathon: run `corepack pnpm i` once).
# E2E: scripts/core_e2e_local.sh when Docker is running; set GATE_SKIP_E2E=1 to skip (printed as SKIPPED).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
stream="${1:-all}"
results=()
failed=0
if command -v pnpm >/dev/null 2>&1; then pnpm_cmd="pnpm"; else pnpm_cmd="corepack pnpm"; fi

step() {  # step <name> <cmd...>
  local name="$1"; shift
  printf '\n\033[1m== %s\033[0m\n' "$name"
  if "$@"; then results+=("PASS  $name"); else results+=("FAIL  $name"); failed=1; fi
}
skip() { printf '\n\033[33m== SKIPPED %s: %s\033[0m\n' "$1" "$2"; results+=("SKIP  $1 ($2)"); }

pytest_if() {  # pytest_if <name> <dir>
  if [ -n "$(find "$2" -name 'test_*.py' -not -path '*/node_modules/*' -print -quit 2>/dev/null)" ]; then
    step "$1" uv run pytest "$2" -q -p no:cacheprovider --timeout=120
  else
    skip "$1" "no tests in $2"
  fi
}

step "privacy boundary" bash scripts/check_privacy.sh
step "uv sync" uv sync --all-packages -q
step "contracts" uv run pytest packages/common -q -p no:cacheprovider
step "generated contracts.ts + schemas up to date" uv run python scripts/core_gen_ts.py --check

# (bash 3.2: no `;;&` fall-through, so plain ifs)
if [ "$stream" = core ] || [ "$stream" = all ]; then
  pytest_if "server tests" server/tests
fi
if [ "$stream" = signals ] || [ "$stream" = all ]; then
  pytest_if "features tests" packages/features
  pytest_if "ml tests" packages/ml
  pytest_if "agent tests" agent
fi
if [ "$stream" = voice ] || [ "$stream" = all ]; then
  if [ -x scripts/voice_test.sh ]; then step "voice_test.sh" scripts/voice_test.sh; fi
  pytest_if "hearsay tests" packages/hearsay
  pytest_if "server tests (voice lives in server/app/voice)" server/tests
fi

if [ "${GATE_SKIP_WEB:-0}" = "1" ]; then
  skip "web" "GATE_SKIP_WEB=1"
elif [ -d web/node_modules ]; then
  step "web typecheck" bash -c "cd web && $pnpm_cmd run typecheck"
  step "web tests" bash -c "cd web && $pnpm_cmd run test"
else
  skip "web" "web/node_modules missing (pnpm --dir web install --frozen-lockfile)"
fi

if [ -d overlay/node_modules ]; then
  step "overlay typecheck + tests" bash -c "cd overlay && $pnpm_cmd run test"
else
  skip "overlay" "overlay/node_modules missing (pnpm --dir overlay install --frozen-lockfile)"
fi

if [ "${GATE_SKIP_E2E:-0}" = "1" ]; then
  skip "e2e" "GATE_SKIP_E2E=1"
elif ! docker info >/dev/null 2>&1; then
  skip "e2e" "docker not running"
elif [ -x scripts/core_e2e_local.sh ]; then
  step "e2e (core_e2e_local.sh)" scripts/core_e2e_local.sh
else
  skip "e2e" "scripts/core_e2e_local.sh not present yet"
fi

printf '\n\033[1m== gate summary (%s)\033[0m\n' "$stream"
printf '%s\n' "${results[@]}"
if [ "$failed" -ne 0 ]; then printf '\033[31mGATE FAILED\033[0m\n'; exit 1; fi
printf '\033[32mGATE PASSED\033[0m\n'
