# Runtime measurements

No detector latency measurements yet. Batch-box access is pending. Torch and
model weights have not been installed on the demo laptop.

| Target | DF_Arena ms/window | ECAPA ms/utterance | Full response p95 | Status |
|---|---:|---:|---:|---|
| amd64 batch box | — | — | — | awaiting SSH target |
| Vultr serving VM | — | — | — | awaiting target and CP0 integration |

Record CPU/GPU, RAM, Python/torch versions, exact model revision, thread count,
warm-up count, sample duration, window count, and at least 20 warmed timings.
Report median and p95; cold downloads are a separate measurement.

Local foundation validation uses Python 3.12.13, numpy 2.5.3, soundfile 0.14.0,
soxr 1.1.0, pytest 9.1.1 and ffmpeg. These are utility tests, not detector or
speaker verification measurements. The shared uv lock remains Claude-owned.

The runnable measurement harness is now `scripts/voice_model_smoke.py`; see
README for invocation. It reports 40 warmed samples per stage and score-direction
checks using 20 real + 20 consented ElevenLabs clips. Unit tests exercise the
harness with fake models only. No real latency numbers are available yet.

`scripts/voice_setup_box.sh` now owns the repeatable Linux amd64 setup. It syncs
the locked workspace, resolves mutable Hugging Face `main` refs to full SHAs,
records the otherwise nested DF_Arena backbone revision, preloads the models and
then calls the smoke harness when consented corpus paths are supplied. Runtime
artifacts stay below ignored `data/voice-runtime/`; later runs reuse those pins
unless the operator explicitly passes `--refresh-revisions`. It deliberately
does not invent calibration or copy recordings. The serving environment remains
fail-closed until `data/voice-runtime/calibration/expo.json` is supplied.
