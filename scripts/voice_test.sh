#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
voice_python="${HEARSAY_TEST_PYTHON:-}"
if [ -z "$voice_python" ]; then
  voice_python="$(uv run --no-sync python -c 'import sys; print(sys.executable)')"
fi
export PYTHONPATH="$PWD/server:$PWD/packages/hearsay/src${PYTHONPATH:+:$PYTHONPATH}"
"$voice_python" -m pytest packages/hearsay/tests server/app/voice/tests -q
"$voice_python" -m ruff check --config packages/hearsay/pyproject.toml packages/hearsay server/app/voice scripts/voice_check_metrics.py scripts/voice_model_smoke.py
"$voice_python" -m ruff format --check --config packages/hearsay/pyproject.toml packages/hearsay server/app/voice scripts/voice_check_metrics.py scripts/voice_model_smoke.py
