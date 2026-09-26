# Queue — Codex 2 (Workstream C: voice and Hearsay)

Seeded by Claude from IMPLEMENTATION.md §8 at CP0; humans may reorder. Branch `ws-voice`.
If blocked → `contracts/REQUESTS.md` → next item.

1. C0 package + DF_Arena/ECAPA on the batch box (fallback decision 02:15)
2. C1 Hearsay safety TSV by 05:00; C1b harvest; C1c dev set
3. C0.5 spoof smoke test with A (03:00–04:30) → attack-delivery decision at CP1, `VOICE_T_CM` v0
4. C2 step-up service in `server/app/voice/` (you own it from CP0) → C3 web voice + `/verify` + `/shop`
5. C2.7 live attack tool (CP3) → C4-lite → C5-lite (TSV v2 by 18:00) → C6 packaging

## CP0 interface notes from Claude
- **Keep these exports** in `server/app/voice/__init__.py`: `router` (mounted at `/api`, so use `prefix="/voice"`),
  `issuer`, `async startup()`, `score_audio(x, sr, profile) -> CMResult`. The A0 stub shows every endpoint working.
- `issuer` implements `app.core.ports.ChallengeIssuer`: `issue(...)`, `open_for_device(device_id)`, plus two methods added
  at CP0: **`refresh(challenge_id, *, trigger=None, decision_id=None)`** (same id, fresh phrase — the hub calls it when a
  step-up consumes an armed proactive challenge) and **`cancel(challenge_id, reason)` / `expire(challenge_id)`** (demo reset
  and the 180 s proactive expiry). The hub enforces one-open-challenge-per-device.
- Persistence: `app.db.repo_voice` — `insert_profile(...)`, `get_active_profile(user_id)`, `get_profiles(user_id)` (quiet +
  expo centroids), `insert_challenge(row)`, `update_challenge(id, **cols)`, `get_challenge(id)`. Memory-first with Tiger
  write-through; profiles mirrored to `data/voice_profiles/*.npz`. **Keep `status` current** via `update_challenge`.
- Hub callbacks: `app.core.events.challenge_status(id, status, attempt)`, `voice_stage(id, stage, ok, value)`,
  **`voice_decided(id, result, web_session_id=principal.sid)`** (pass the requester's web session: VERIFY resolves an
  attached decision to Y only for the same web session), `totp_decided(id, ok, web_session_id=...)`,
  `can_request_unlock(device_id, principal.session_created_at)`.
- TOTP core lives in `app.core.totp` (`enroll(user)`, `verify(user, code)`); the stub's `/voice/totp/*` shows usage.
- Auth dependency: `from app.auth import CurrentPrincipal` (`p.user`, `p.sid`, `p.is_admin`, `p.session_created_at`).
- `ChallengeStatus` values are in `twobme_common.types` (add new ones via CHANGELOG line; it's a Literal).
- Test harness: `server/tests/test_flows.py` (uses `X-Fake-Decision`; keep the header working in `ELEVENLABS_MODE=stub`
  or tell Claude so the tests can switch to your stub mode).

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
   Local implementation complete against CP0 generated API contracts. Includes
   enrollment, retries, TOTP, stage feedback and server-bound checkout outcomes.
   Web tests/typecheck/static build passed. Physical microphone/browser and real
   model integration remain pending; enrolled LTAS display needs the shared DTO.
6. **C0.5 / C4-lite:** consented teammate mic recordings and spoof calibration.
7. **C1b / C1c / C5-lite / C6:** harvest, dev evaluation, ranked fusion and offline
   amd64 packaging when rules, datasets and runtime are available.

No P1/P2 work until the plan's CP4 gate is green.

CP0 was merged locally at `7a80af0`. C2 service ownership is now available;
calibrated live integration still needs model runtime and spectral-contract
resolution. The CP0 backend currently remains a stub.

## Claude notes, 02:40 ET (on main)
- `/shop` and `/verify` now have WORKING stubs (Claude, A0) — yours to replace in C3: `web/src/app/{shop,verify}/page.tsx`,
  `web/src/components/{shop-stub,verify-stub}/`. They already do the full flow against the voice STUB (verified on a real
  backend): Pay → C → /verify → prompt → 6 s PCM16 WAV → result + resolved orders, RETRY, TOTP. Reuse or delete freely;
  your components go in `web/src/components/voice/`.
- `client_prompt_end_ms` = ms from recorder start (mic open) to the prompt's `ended` event. The WAV already starts at prompt
  end — don't trim by it (contracts/CHANGELOG.md).
- Answers to your REQUESTS.md items are in `contracts/REQUESTS.md` (rank offset −0.5, `mfcc_mean vector(20)`, precedence OK).
- **Overlay (14:30 ET, user decision):** `/overlay` (Claude, `web/src/components/overlay/`) embeds the voice check in an Electron
  window on A's Mac. It currently imports `ChallengeFlow` from `web/src/components/verify-stub/`. When your
  `web/src/components/voice/ChallengeFlow` lands, keep it embeddable (no page-level layout, works on a transparent/dim
  background, no autoplay — one "Start voice check" gesture) and tell Claude in STATUS.md so the overlay switches imports.
- **Merged 2026-09-26, ws-voice → ws-core.** Took your `/shop` and `/verify` wholesale; `shop-stub/` was fully dead so it's
  deleted. The overlay's full-screen voice check (proactive step-up + unlock) now renders your real
  `voice/challenge-flow.tsx` when live, confirming it's exactly as embeddable as asked — no page layout, no onDone/onMfaDone
  needed since overlay mode is driven by live server state, not callbacks. **Kept `verify-stub/` + its `mockBackend`**,
  used only under `?mock=1`/`NEXT_PUBLIC_MOCK=1` for offline rehearsal/dev, since your component has no mock path and
  hardcodes the real API — didn't want to lose that for this pass. Ping me in STATUS.md if you'd rather I drop mock-mode
  support so `verify-stub/` can go too. **Product direction changed (see `newGoal.txt`, root, and IMPLEMENTATION.md §2.4,
  currently PROPOSED):** the Electron overlay is now the primary surface for voice/behavioral verification; the `.tech`
  site is being repositioned as an org/admin control panel. `/shop` and `/verify` stay as the hackathon demo but I won't
  be investing further in them as customer-facing pages — flagging so C3 effort goes toward the overlay-embeddable pieces
  (`voice/challenge-flow.tsx`, `voice-recorder.tsx`) rather than page polish.

## C2 progress — 2026-09-26

- Real service wiring is implemented: guarded warm-up, VAD + concurrent STT / CM /
  ECAPA / DSP, calibrated decision rules, five-take derived-profile enrollment,
  single-use persisted prompts, challenge retries/expiry, TOTP gating, bounded
  uploads and same-session order callbacks. Stub mode remains available only for
  demos; real mode never falls back to fake verification.
- Next: provision `hearsay[server]` in the core-owned VM image, supply pinned
  revisions and measured calibration, then run batch/VM model smoke and
  microphone validation. Core requests and setup are documented. Spectral
  dimensions and rank-offset ambiguities are resolved.
