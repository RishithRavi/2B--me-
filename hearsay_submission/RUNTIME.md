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
