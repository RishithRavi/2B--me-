#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
voice_python="${HEARSAY_TEST_PYTHON:-python3.12}"
export PYTHONPATH="$PWD/packages/hearsay/src${PYTHONPATH:+:$PYTHONPATH}"
"$voice_python" -m pytest packages/hearsay/tests -q
"$voice_python" -m ruff check --config packages/hearsay/pyproject.toml packages/hearsay scripts/voice_check_metrics.py scripts/voice_model_smoke.py
"$voice_python" -m ruff format --check --config packages/hearsay/pyproject.toml packages/hearsay scripts/voice_check_metrics.py scripts/voice_model_smoke.py
