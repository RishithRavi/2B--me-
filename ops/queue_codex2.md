# Codex 2 queue — ws-voice

Bootstrapped from IMPLEMENTATION.md §8 because no human queue existed at start.
If blocked, append the dependency to `contracts/REQUESTS.md` and take the next
independent task. Never claim a submission, model test or merge gate has passed
without running it.

1. **DONE — C0 local foundations:** package, native audio → mono 16 kHz float32, ffmpeg
   fallback, CM windows, 300-word list, cryptographic phrases, TSV writer, minDCF
   and tests. Done when Python 3.12 unit tests, actual Opus fallback and official
   ASVspoof5 metric parity pass.
2. **C0 batch smoke:** load DF_Arena, ECAPA, Silero; verify logits and time each
   on the batch box and VM. Adapters and `voice_model_smoke.py` implemented and
   tested with fakes. Requires SSH target. Record actual RUNTIME results.
3. **C1:** official rules/template and corpus → resumable inference, 20+20
   direction test, safety TSV. Resumable single-process `hearsay predict` now
   implemented; four-worker tuning pending. Requires official materials and box.
4. **C2:** after CP0 handoff, implement service and calibrated decision pipeline,
   audio deletion, challenges and retries through shared ports. Requires frozen
   DTOs, voice stub and resolution of requested contract ambiguities. Pure
   decision rules, VAD preparation and required DSP are implemented/tested.
5. **C3:** native-rate AudioWorklet recording, ChallengeFlow, /verify and /shop.
   Integrate against the core web shell and generated API contracts.
6. **C0.5 / C4-lite:** consented teammate mic recordings and spoof calibration.
7. **C1b / C1c / C5-lite / C6:** harvest, dev evaluation, ranked fusion and offline
   amd64 packaging when rules, datasets and runtime are available.

No P1/P2 work until the plan's CP4 gate is green.
