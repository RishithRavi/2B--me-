#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/voice_setup_box.sh [options]

Run on the Linux amd64 batch box or serving VM from a clean repository checkout.

Options:
  --runtime-root PATH   Cache, manifests and reports (default: data/voice-runtime)
  --model NAME          df-arena or fallback (default: df-arena)
  --real-dir PATH       Directory with at least 20 consented genuine clips
  --synth-dir PATH      Directory with at least 20 consented ElevenLabs clips
  --refresh-revisions   Resolve main again instead of reusing recorded revisions
  --resolve-only        Install dependencies and resolve pins; do not download weights
  --skip-smoke          Preload models but do not run the consented corpus smoke test
  --threads N           Torch CPU threads (default: 6)
  -h, --help            Show this help
EOF
}

runtime_root=data/voice-runtime
model=df-arena
real_dir=
synth_dir=
resolve_only=0
skip_smoke=0
refresh_revisions=0
threads=6
while (($#)); do
  case "$1" in
    --runtime-root) runtime_root=${2:?missing runtime root}; shift 2 ;;
    --model) model=${2:?missing model}; shift 2 ;;
    --real-dir) real_dir=${2:?missing real directory}; shift 2 ;;
    --synth-dir) synth_dir=${2:?missing synthetic directory}; shift 2 ;;
    --refresh-revisions) refresh_revisions=1; shift ;;
    --resolve-only) resolve_only=1; shift ;;
    --skip-smoke) skip_smoke=1; shift ;;
    --threads) threads=${2:?missing thread count}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ $(uname -s) == Linux ]] || { echo "run this only on the Linux runtime host" >&2; exit 2; }
[[ $(uname -m) == x86_64 ]] || { echo "Linux amd64 is required" >&2; exit 2; }
[[ $model == df-arena || $model == fallback ]] || { echo "invalid model" >&2; exit 2; }
[[ $threads =~ ^[1-9][0-9]*$ ]] || { echo "threads must be positive" >&2; exit 2; }
[[ -f pyproject.toml && -f packages/hearsay/pyproject.toml ]] || {
  echo "run from the 2bME repository root" >&2
  exit 2
}
command -v uv >/dev/null || { echo "uv is required" >&2; exit 2; }
available_kib=$(df -Pk . | awk 'NR == 2 {print $4}')
((available_kib >= 12582912)) || { echo "at least 12 GiB free disk is required" >&2; exit 2; }

mkdir -p "$runtime_root" "$runtime_root/calibration" "$runtime_root/reports"
uv sync --frozen --all-packages --all-extras --no-default-groups
if ((refresh_revisions)) || [[ ! -f $runtime_root/model-revisions.json && ! -f $runtime_root/voice-runtime.env ]]; then
  .venv/bin/python scripts/voice_resolve_revisions.py \
    --model "$model" \
    --runtime-root "$runtime_root"
elif [[ ! -f $runtime_root/model-revisions.json || ! -f $runtime_root/voice-runtime.env ]]; then
  echo "runtime revision state is incomplete; inspect it, then use --refresh-revisions" >&2
  exit 2
else
  echo "Reusing recorded revisions in $runtime_root/model-revisions.json"
fi

set -a
# This file contains no credentials; it is mode 0600 to keep deployment defaults private.
source "$runtime_root/voice-runtime.env"
set +a
expected_model=Speech-Arena-2025/DF_Arena_500M_V_1
[[ $model == fallback ]] && expected_model=garystafford/wav2vec2-deepfake-voice-detector
if [[ $VOICE_CM_MODEL != "$expected_model" ]]; then
  echo "recorded detector does not match --model; use --refresh-revisions to change it" >&2
  exit 2
fi
echo "Resolved immutable model revisions in $runtime_root/model-revisions.json"
if ((resolve_only)); then
  echo "Resolve-only setup complete; weights were not downloaded."
  exit 0
fi

HF_HOME=$HF_HOME .venv/bin/python scripts/voice_preload_models.py \
  --model "$model" \
  --cm-revision "$VOICE_CM_REVISION" \
  --ecapa-revision "$VOICE_ECAPA_REVISION" \
  --threads "$threads" \
  --speaker-cache "$runtime_root/models/ecapa" \
  --output "$runtime_root/reports/model-preload.json"

if ((skip_smoke)); then
  echo "Preload complete. Accuracy and response latency remain unverified."
  exit 0
fi
if [[ -z $real_dir || -z $synth_dir ]]; then
  echo "Preload complete; pass --real-dir and --synth-dir to run the required 20+20 smoke test." >&2
  exit 3
fi
HF_HOME=$HF_HOME .venv/bin/python scripts/voice_model_smoke.py \
  --real-dir "$real_dir" \
  --synth-dir "$synth_dir" \
  --model "$model" \
  --cm-revision "$VOICE_CM_REVISION" \
  --ecapa-revision "$VOICE_ECAPA_REVISION" \
  --speaker-cache "$runtime_root/models/ecapa" \
  --device cpu \
  --threads "$threads" \
  --output "$runtime_root/reports/model-smoke.json"

if [[ ! -f $VOICE_CALIBRATION_PATH ]]; then
  echo "Smoke passed, but real service remains fail-closed until measured calibration exists at:" >&2
  echo "$VOICE_CALIBRATION_PATH" >&2
  exit 4
fi
echo "Voice runtime setup and model smoke passed; calibration file is present."
