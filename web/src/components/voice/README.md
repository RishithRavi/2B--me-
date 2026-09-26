# Browser voice flow

`VoiceRecorder` owns microphone acquisition, prompt playback, six-second native
PCM capture, cancellation and cleanup. It is shared by enrollment and challenges.
The server resamples the mono PCM16 WAV. `client_prompt_end_ms` is the native
AudioContext time elapsed since the pinned microphone opened; the uploaded WAV already
excludes the prompt, so the server must not trim that timestamp from the WAV.

Set `NEXT_PUBLIC_VOICE_MIC_LABEL` at web build time to the demo microphone label,
or enter the matching name in the recorder. A unique non-default device must
match; it is then opened with an exact device ID. The entered name is retained
only in module memory for the next phrase. No audio goes into browser storage.
Microphone permission requires HTTPS or localhost. Prompt playback is initiated
by a click; failed playback exposes the explicit Speak now fallback.

`ChallengeFlow` uses the generated API types and the real live-event connection,
handles retries and TOTP, and reports server outcomes. `/shop` resolves only its
own pending decision and polls it to recover an expiry or completion in another
view. A final declined order is never reopened by a later voice outcome.

The server supports explicit demo stub mode and calibrated real mode. Real mode
requires installed models and calibration before accepting requests. Actual mic
capture, autoplay fallback across supported browsers, enrollment and model
inference still need demo-hardware integration validation.
The current DTO does not expose the enrolled LTAS; SpectrogramView can display
only the response until the requested contract extension is available.

Run `corepack pnpm --dir web test`, `corepack pnpm --dir web typecheck` and
`corepack pnpm --dir web build`. The voice tests execute the actual worklet in a
VM at 44.1/48 kHz and cover prompt exclusion, exact duration, WAV packing,
cancellation, wrong-mic cleanup and order-bound outcomes. They use synthetic
frames and fake browser media objects, not recordings or a physical microphone.
