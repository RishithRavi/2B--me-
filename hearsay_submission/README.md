# Hearsay / 2bME voice workstream

Local C0 utilities, model adapters, resumable inference, DSP and pure step-up
decision rules are implemented. There is no safety TSV, trained model,
published image, calibrated voice verifier or measured detection result yet.
Official rules remain [unconfirmed](RULES.md); hardware timings are tracked in
[RUNTIME.md](RUNTIME.md).

From the `ws-voice` worktree, with Python 3.12:

```sh
uv venv --python 3.12
uv pip install -e 'packages/hearsay[test]'
HEARSAY_TEST_PYTHON=.venv/bin/python bash scripts/voice_test.sh
.venv/bin/python -m hearsay phrase
.venv/bin/python -m hearsay eval data/hearsay/dev_scores.json
.venv/bin/python -m hearsay direction-check data/redteam/direction_scores.json
.venv/bin/python -m hearsay write-tsv data/hearsay/margins.json \
  --template data/hearsay/official_template.tsv \
  --direction synth_high -o data/hearsay/draft.tsv
```

The last command requires official direction confirmation; `synth_high` is only
an example. The rank offset currently follows the plan's literal `+0.5`; confirm
the range ambiguity before use. Override `--rank-offset -0.5` only after that
decision. Config lives in `packages/hearsay/src/hearsay/config.yaml`; pass
`--config path.yaml` before the subcommand to override it.

Saved evaluation JSON is `{"real": [margins], "synth": [margins]}`; all input
margins must be synthetic-high. Writer input maps file names to finite margins,
or `null` only for files actually attempted but unreadable. Missing, duplicate,
extra and nonfinite predictions fail. The writer preserves the template header,
row order, line endings and every field except column 2. Unreadable files go to
the real end of the ranking. Output replacement is atomic.

minDCF uses configurable priors/costs and ASVspoof5 normalization with the scores
negated for bona-high evaluation. EER and DET retain the official reference's
stable tie ordering. The reference is the organizers'
[evaluation package](https://github.com/asvspoof-challenge/asvspoof5/blob/main/evaluation-package/calculate_modules.py).
To compare an independently downloaded copy:

```sh
.venv/bin/python scripts/voice_check_metrics.py --reference /tmp/calculate_modules.py
```

The audio utility uses soundfile/soxr HQ and an in-memory ffmpeg fallback, with
duration limits and no audio copies on disk. Temporary synthetic clips for tests
live only in pytest's temporary directory. Upload ownership and deletion will
be implemented with the server integration after CP0. Importing the package
never loads models or calls ElevenLabs.

Five-word phrases use `secrets` and a 300-word vocabulary. Native-rate audio is
converted to 16 kHz mono float32. CM slicing takes one onset window for step-up
or at most three evenly spaced windows with a right-aligned tail for Hearsay.
The model integration will use the DF_Arena
[documented logits](https://huggingface.co/Speech-Arena-2025/DF_Arena_500M_V_1)
with index 0 representing spoof; utility tests cannot establish actual clone
detection accuracy.

Remaining submission sections (metrics, forensic techniques, trace, leakage
controls, ablations/DET, hardest real clips, reproduction, limitations/licenses
and 2bME integration) will be completed with measured artifacts. Planned model
and dataset licensing includes DF_Arena non-commercial, DiffSSD NC-ND and
parselmouth GPL; verify before distribution. Development tooling: OpenAI Codex.

## Batch-box inference and smoke test

Install `hearsay[server]` on the batch box for DF_Arena/fallback, ECAPA and Silero.
No model is loaded by importing the package or displaying CLI help. Model loads
require full immutable Hugging Face commit SHAs. Fallback selection is explicit;
runtime failures never silently switch detectors within one ranking.

```sh
python -m hearsay predict data/hearsay/test \
  --template data/hearsay/official_template.tsv \
  --partial data/hearsay/predictions.partial.tsv \
  --model df-arena --revision "$CM_REVISION" --device cpu --threads 4 \
  --direction synth_high -o data/hearsay/draft.tsv

python scripts/voice_model_smoke.py \
  --real-dir data/redteam/real --synth-dir data/redteam/elevenlabs \
  --cm-revision "$CM_REVISION" --ecapa-revision "$ECAPA_REVISION" \
  --speaker-cache data/models/ecapa --device cpu --threads 6 \
  -o data/calibration/model-smoke.json
```

Confirm official direction/rank range before the first command. It checkpoints
raw synthetic-high margins every 50 clips and on clean exceptions. Resume
requires matching detector, template, paths, sizes and modification times. A
partial final row after an interrupted write is retried. Two processes cannot
write the same checkpoint. The current runner is single-process; four-worker
throughput tuning remains pending on the batch box. Reformatting a complete
journal needs no model load. Model errors stop inference; only decode errors
are recorded as unreadable. Final output appears only after every file has been
attempted and input metadata has been checked again. Files under `data/` are
local runtime artifacts and must never be committed.

The smoke command requires 20 genuine and 20 consented ElevenLabs clips, checks
VAD silence, warms models twice, and measures 40 samples per stage. It records
median/p95 timings and direction checks for both profiles. These sequential
measurements exclude STT, prompt playback and upload; they do not establish the
service round-trip budget. No embeddings, waveforms or transcripts are written
to the smoke report. The command has been tested with fake models; real model
loading and accuracy remain **unverified** until it runs on the box.

DF_Arena uses spoof logit index 0; the
[fallback model](https://huggingface.co/garystafford/wav2vec2-deepfake-voice-detector)
uses index 1. ECAPA receives 16 kHz tensors and emits normalized 192-dimensional
embeddings. VAD concatenates speech with merged 150 ms padding and selects the
first segment within 10 dB of the loudest segment for close-talker onset.

The DF_Arena [backbone source](https://huggingface.co/Speech-Arena-2025/DF_Arena_500M_V_1/blob/main/backbone.py)
loads the `facebook/wav2vec2-xls-r-300m` configuration separately. Offline image
packaging must cache that configuration plus all remote-code modules and record
their revisions. The current primary revision flag does not freeze this nested
configuration. `hearsay[detect]` includes `einops`, required by the model's
[Conformer source](https://huggingface.co/Speech-Arena-2025/DF_Arena_500M_V_1/blob/main/conformer.py).

## Step-up primitives awaiting CP0 integration

DSP produces 64-band log-mel LTAS, 20 MFCC means/stds, centroid, rolloff, flatness,
guarded high-frequency energy, autocorrelation F0 and a 64×128 spectrogram.
Pitch is zero when no voiced estimate exists. Measurements alone do not prove
authenticity. Spectral comparisons reject mismatched dimensions; no 84→64
truncation is used to conceal the open profile-contract issue.

The pure decision function requires explicit calibrated thresholds, makes spoof
evidence win over RETRY, routes silence/replay/timing failures through retries,
uses MFA on missing required scores, and retries unlock gray zones. Attempt 3
retries become MFA. It has no trust, lock, session or payment effects. The server
must still compute all scores, enforce challenge/attempt ownership and expiry,
delete uploads in `finally`, and call the shared core decision handler.
