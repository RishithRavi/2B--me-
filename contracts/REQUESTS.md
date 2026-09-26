# Cross-stream requests

Append a request here when you need a file you don't own changed (§0, §4), then move on to your next queue item.
Claude triages within 30 min while awake.

Format:
```
- [ ] YYYY-MM-DD HH:MM ET · from <agent> → <owner> · <file/area> · <what and why> · <blocking? y/n>
```
Owners mark `[x]` with the commit SHA when done, or `[-]` with a reason.

## Open

## Done

## Codex 2 — 2026-09-26 — C0 / pre-CP0

- **Claude:** please expose the CP0 shared voice DTOs (`VoiceResult`, `CMResult`,
  `ChallengeOut`, `VoiceOutcome`) and commit the voice stub, ports, repository and
  event interfaces before the `server/app/voice` ownership transfer. Codex 2 is
  building only `packages/hearsay` until that handoff. Register the package in
  the root uv workspace and include `scripts/voice_test.sh` in the voice gate.
- **Person A / Claude:** §8 C1 specifies `(rankdata(llr, 'average') + 0.5)/N`.
  SciPy ranks start at 1, so the maximum is `1 + 0.5/N`. Confirm whether the
  official range permits that or the intended offset is `-0.5`. Hearsay keeps
  the literal `+0.5` configurable, supports a final rank reversal, and rejects
  values outside any configured official range. No official TSV has been made.
- **Person A:** supply the official Hearsay PDF, template, test paths, team
  filename, score direction/range, metric costs and deadlines. These are marked
  unconfirmed in `hearsay_submission/RULES.md` and package config.
- **Person B:** provide the batch-box SSH alias/path; no torch or model weights
  have been downloaded to the demo laptop. DF_Arena/ECAPA/Silero model smoke
  tests and real hardware timing remain pending.
- **Claude:** resolve the spectral-profile dimensional mismatch: §5.5 stores
  `spectral_summary vector(64)`, but §8 C2 compares `[LTAS(64) | MFCC-mean(20)]`
  against it. Specify a 64-dimensional comparison or an 84-dimensional shared
  profile before voice enrollment integration.
- **Claude:** clarify spoof/short-speech precedence. §8 C2 lists short VAD first
  but says spoof always wins; §11.2 explicitly requires spoof to beat RETRY.
  Proposed behavior: when a valid CM score exists, BLOCK_SPOOF precedes all
  RETRY gates; silence with no CM evidence returns RETRY.
- **Claude:** root README Hearsay judge box is core-owned; add links to
  `hearsay_submission/README.md`, TSV and image when actual artifacts exist.

## Codex 2 — 2026-09-26 — next tranche

- Draft shared DTOs and voice stub are now visible in the uncommitted ws-core
  worktree; no CP0 tag/commit exists yet. Codex 2 has left those files untouched.
  `hearsay.models`, `vad`, `dsp`, `decision` and resumable `predict` are ready for
  integration after handoff. The package's internal dictionary results do not
  define replacement shared wire DTOs.
- Proposed §11.2 precedence is implemented as a pure, side-effect-free function:
  valid spoof evidence wins over short speech and phrase RETRY. No routes use it
  until CP0 integration. Spectral comparisons still require equal dimensions.
- Batch smoke harness is ready: `scripts/voice_model_smoke.py`. Still requires
  the SSH target plus 20 genuine/20 consented ElevenLabs recordings. No real
  model weights, timing or calibration were produced locally.

## Codex 2 — CP0 integrated / C3 web

- CP0 handoff is now integrated in `ws-voice` (`7a80af0`); the earlier CP0
  blockers above are historical. Web components use generated contracts.
- **Claude / spectral contract:** the response exposes the reply spectrogram but
  no enrolled LTAS. Please expose the comparison profile for the requested
  side-by-side display, and resolve the existing 64-vs-84 profile question.
- **Claude / web deployment:** map the operator's `VOICE_MIC_LABEL` to build-time
  `NEXT_PUBLIC_VOICE_MIC_LABEL`. The current recorder also accepts an explicit
  unique microphone name and refuses an ambiguous/default-device fallback.
- **Claude / uv.lock:** `uv sync --all-packages` resolves the new hearsay package
  successfully but updates the core-owned lock. Please regenerate and commit it
  at merge. Codex 2 restored its gate-generated lock change; a local copy of the
  patch is `/private/tmp/2bme-voice-uv-lock.patch`.
- **Claude / e2e gate:** `scripts/gate.sh voice` passes, but skips end-to-end
  validation because `scripts/core_e2e_local.sh` is absent on the CP0 base.
  Real microphone/model tests remain pending, separate from this missing gate.
