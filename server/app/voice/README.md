# Voice service (C2)

The CP0 exports remain `router`, `issuer`, `startup()` and
`score_audio(x, sr, profile)`. The service now has two distinct modes:

- `VOICE_MODE=stub` preserves the original canned demo and `X-Fake-Decision`
  harness. It is rejected when `DEMO_MODE=false`. With no explicit voice mode,
  `DEMO_MODE=true` plus `ELEVENLABS_MODE=stub` retains the existing demo default.
- `VOICE_MODE=real` uses Hearsay VAD, CM, ECAPA and DSP plus STT. Missing
  dependencies, pins, calibration or unsuccessful warm-up leave `/api/healthz`
  at 503 and voice routes unavailable. Real mode rejects fake-decision headers.

## Runtime setup (batch box / VM only)

The core-owned server package and image still need to install `hearsay[server]`
as a workspace dependency. That request is in `contracts/REQUESTS.md`. Until
then, use the checked-in setup command from a clean checkout on the Linux amd64
batch box or serving VM:

```sh
scripts/voice_setup_box.sh --preflight-only
scripts/voice_setup_box.sh --resolve-only
scripts/voice_setup_box.sh --skip-smoke
scripts/voice_setup_box.sh \
  --real-dir /private/consented/real \
  --synth-dir /private/consented/elevenlabs
```

The supported production host is the runbook's 8-vCPU/16-GiB Linux amd64 VM.
Setup refuses smaller machines before installing dependencies or downloading
weights. `--allow-undersized` is an explicit measurement-only escape hatch; it
does not waive the real-mode latency, warm-up or reliability gates and must not
be used to describe an undersized deployment as production-ready.

The preflight command makes no changes. The resolve-only command installs the
locked workspace dependencies and resolves the current model refs to full
commit SHAs without downloading weights. The next command downloads and warms
the pinned models. The final command runs the required 20+20 consented direction
and timing smoke test. Artifacts are written under ignored
`data/voice-runtime/`: `model-revisions.json`, `voice-runtime.env`, and reports.
Later runs reuse the recorded revisions; `--refresh-revisions` is required to
resolve mutable `main` refs again. The environment file contains no API keys.
Setup exits nonzero after a successful preload or smoke when more evidence is
still required; `--skip-smoke` is the explicit compatibility-only path. Do not
run any of these commands on the demo laptop. Stub imports do not require
Hearsay's optional model dependencies.

DF_Arena remote code separately resolves its wav2vec2 backbone. Setup records
the backbone's full SHA for audit, but the upstream loader has no revision input
for that nested fetch. Keep the warmed Hugging Face cache with the deployment
until this upstream limitation is removed; do not describe the nested dependency
as cryptographically pinned.

Required real-mode settings:

| Setting | Meaning |
| --- | --- |
| `VOICE_MODE=real` | Select real scoring explicitly |
| `VOICE_CM_MODEL` | DF_Arena default, or the supported Gary Stafford fallback |
| `VOICE_CM_REVISION` | Full 40-character HF model commit SHA |
| `VOICE_ECAPA_REVISION` | Full HF ECAPA commit SHA |
| `VOICE_CALIBRATION_PATH` | Measured calibration JSON bound to both model revisions |
| `VOICE_DEVICE` | `cpu` (default) or `cuda` |
| `STT_BACKEND=local` | Use preinstalled faster-whisper from `VOICE_LOCAL_STT_PATH` |
| `ELEVENLABS_MODE=stub` | Local beep prompt + displayed phrase; forces local STT |
| `ELEVENLABS_MODE=live` | Persisted, single-use ElevenLabs prompt pool |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_PROMPT_VOICE_ID` | Required for live prompts |
| `STT_BACKEND=elevenlabs` | Use Scribe only when ElevenLabs mode is also live |
| `VOICE_ENROLLMENT_LABEL` | `quiet` (default), or `expo` for the second centroid |

Calibration JSON contains `model`, `revision`, `speaker_revision`,
`thresholds: {asv_low, asv_high, cm, spectral}`, `cm_scale`, and `cm_bias`.
All values must come from calibration; no production thresholds are supplied.
CM probability is `sigmoid(cm_scale * synthetic_high_margin + cm_bias)` with a
strictly positive scale. Changing a model revision requires matching calibration.
Official Hearsay score direction/range still need organizer confirmation; its
approved rank offset is now `-0.5`.

Live prompt startup fills a persisted pool to 50 entries and tops it back up only
below 20 unused entries. It makes paid TTS calls when configured and explicitly
run. Used entries are marked on disk before being issued; generated prompts are
the only audio this service persists. A prompt's first GET starts a maximum
30-second response deadline; replaying it cannot extend the deadline.
The pool assumes the plan's single API worker and persisted `DATA_DIR` volume.
A missing/corrupt pool or provider failure does not silently select stub scoring.

Provider references: [Scribe](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)
and [prompt TTS](https://elevenlabs.io/docs/api-reference/text-to-speech/convert).
No phrase/keyterms/initial prompt are passed to STT. With Scribe, challenge audio
leaves this server for ElevenLabs as described by the product's privacy disclosure;
local STT avoids that transmission. Neither transcripts nor provider error bodies
are persisted or included in result findings.

## Request behavior

Uploads are capped at 8 MiB by the voice reader, decoded in memory (WAV or bounded
ffmpeg WebM fallback), checked for finite samples and a maximum 6.25-second
window, and resampled with soxr HQ. Starlette may spool multipart uploads; every
upload is closed in a `finally` block so its temporary file is removed. This
reader cap does not replace an ingress/proxy request-size limit. Two inference
slots bound decoded PCM; one dedicated CM executor serializes CM work. The
router lifespan closes that executor at shutdown.

VAD feeds independent STT, CM, speaker and DSP stages. All available scores run
before a decision. Valid spoof evidence wins even if STT fails. Unavailable
required evidence never verifies. Profiles use 64 LTAS bins plus 20 MFCC means,
and speaker matching takes the best quiet/expo centroid. Voice confidence uses
`asv_norm=(cosine+1)/2`; this display score does not override decision gates.

Each real enrollment is tied to the user and cookie session, expires after ten
minutes, and is consumed once. All five fresh phrases must pass phrase,
anti-spoof and speech checks, total at least 20 seconds of net speech, and have
minimum pairwise cosine >= 0.5. Only derived profiles are persisted.

A response requires prompt acknowledgement. Duplicate/concurrent submissions
are rejected. Cancellation, expiry or refresh during scoring cannot apply a
late result. RETRY creates a fresh phrase and prompt; attempt three becomes MFA.
TOTP is accepted only during fallback and its 90-second window. Shared core
callbacks own all device and order effects, including same-cookie order binding.
`client_prompt_end_ms` is diagnostic only; uploaded audio already excludes the
prompt and is never trimmed by that value.

## Validation and remaining work

`scripts/voice_test.sh` now runs package and service tests with the workspace
Python, then checks formatting/lint. Service tests use injected fake models and
synthetic audio, including real ffmpeg decoding. They cover real HTTP endpoint
wiring, enrollment, stage failures, spoof precedence, retries, expiry, concurrent
submissions, stale results, same-session checkout resolution, and prompt reuse.
The existing core end-to-end rehearsal continues to use explicit stub mode.

Actual model/API compatibility, fitted calibration, detection accuracy and
latency remain unverified until the batch/VM smoke test and consented recordings
are available. Red-team generation/quota tooling is a separate pending queue item.
