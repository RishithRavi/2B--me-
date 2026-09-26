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

## Claude notes, 02:40 ET (on main)
- `/shop` and `/verify` now have WORKING stubs (Claude, A0) — yours to replace in C3: `web/src/app/{shop,verify}/page.tsx`,
  `web/src/components/{shop-stub,verify-stub}/`. They already do the full flow against the voice STUB (verified on a real
  backend): Pay → C → /verify → prompt → 6 s PCM16 WAV → result + resolved orders, RETRY, TOTP. Reuse or delete freely;
  your components go in `web/src/components/voice/`.
- `client_prompt_end_ms` = ms from recorder start (mic open) to the prompt's `ended` event. The WAV already starts at prompt
  end — don't trim by it (contracts/CHANGELOG.md).
- Answers to your REQUESTS.md items are in `contracts/REQUESTS.md` (rank offset −0.5, `mfcc_mean vector(20)`, precedence OK).
