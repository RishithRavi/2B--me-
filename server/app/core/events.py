"""Hub callbacks for server/app/voice (Codex 2). Owner: Claude. §5.6.

    from app.core import events
    await events.challenge_status(challenge_id, "scoring", attempt)     # broadcasts `challenge`
    await events.voice_stage(challenge_id, "anti-spoof", ok=False, value=0.93)
    outcome = await events.voice_decided(challenge_id, result, web_session_id=principal.sid)
    outcome = await events.totp_decided(challenge_id, ok, web_session_id=principal.sid)

`voice_decided` is called for EVERY scored attempt; trust/lock/decision effects happen only on
terminal outcomes (VERIFY, BLOCK_SPOOF, BLOCK_IMPOSTOR; FALLBACK_MFA starts the 90 s TOTP window).
It is the only path that resolves decisions (plus `totp_decided` for FALLBACK_MFA). Pass the
requester's web session id: a VERIFY turns an attached pending decision into Y only for the same
web session (§5.4). `redteam` / `sandbox` challenges never have trust, lock or decision effects.

The voice module must also keep `voice_challenges.status` current via `repo_voice.update_challenge`.
"""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from app.core.runtime import rt
from twobme_common.types import VoiceOutcome, VoiceResult, VoiceStageLive


async def challenge_status(challenge_id: UUID, status: str, attempt: int) -> None:
    await rt().hub.on_challenge_status(challenge_id, status, attempt)


async def voice_stage(challenge_id: UUID, stage: Literal["transcribing", "anti-spoof", "speaker", "spectral", "done"],
                      ok: bool | None = None, value: float | None = None) -> None:
    await rt().hub.on_voice_stage(challenge_id, VoiceStageLive(challenge_id=challenge_id, stage=stage, ok=ok,
                                                               value=value))


async def voice_decided(challenge_id: UUID, result: VoiceResult, *, web_session_id: str | None = None) -> VoiceOutcome:
    return await rt().hub.on_voice_decided(challenge_id, result, web_session_id)


async def totp_decided(challenge_id: UUID, ok: bool, *, web_session_id: str | None = None) -> VoiceOutcome:
    return await rt().hub.on_totp(challenge_id, ok, web_session_id)


def can_request_unlock(device_id: UUID, session_created_at) -> bool:  # noqa: ANN001
    """Unlock challenges only for a cookie session created after `locked_at` (§5.4)."""
    return rt().hub.can_request_unlock(device_id, session_created_at)
