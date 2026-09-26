"""Challenge lifecycle through the shared repository and event ports."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from twobme_common.types import ChallengeOut, utcnow

from app.config import get_settings
from app.core import events
from app.db import repo_voice
from app.voice.state import state

FIXED_PHRASE = "amber river quiet falcon lantern"
TTL_S = {"proactive": 180, "step_up": 120, "unlock": 120, "redteam": 120, "sandbox": 120}


def to_out(row: dict[str, Any]) -> ChallengeOut:
    s = get_settings()
    return ChallengeOut(
        challenge_id=row["id"],
        trigger=row["trigger"],
        status=row["status"],
        attempt=row["attempt"],
        phrase=row["phrase"],
        prompt_url=f"/api/voice/challenges/{row['id']}/prompt.mp3",
        expires_at=row.get("expires_at"),
        verify_url=s.verify_url(row["id"]),
    )


async def fresh_material(challenge_id):
    current = state()
    if current.mode == "stub":
        return FIXED_PHRASE
    if current.prompts:
        identifier, phrase = await current.prompts.claim()
        current.prompt_ids[challenge_id] = identifier
        return phrase
    from hearsay.phrases import new_phrase

    return new_phrase()


class VoiceIssuer:
    async def issue(
        self,
        *,
        device_id: UUID | None,
        subject_user_id: UUID,
        session_id: UUID | None,
        trigger: str,
        decision_id: UUID | None,
    ) -> ChallengeOut:
        current = state()
        async with current.issuance_lock:
            if (
                current.mode == "real"
                and device_id is not None
                and trigger in {"proactive", "step_up", "unlock"}
            ):
                existing = await self.open_for_device(device_id)
                if existing is not None:
                    raise HTTPException(409, "Device already has an open challenge")
            return await self._issue(
                device_id=device_id,
                subject_user_id=subject_user_id,
                session_id=session_id,
                trigger=trigger,
                decision_id=decision_id,
            )

    async def _issue(self, *, device_id, subject_user_id, session_id, trigger, decision_id):
        identifier = uuid.uuid4()
        phrase = await fresh_material(identifier)
        now = utcnow()
        row = {
            "id": identifier,
            "user_id": subject_user_id,
            "device_id": device_id,
            "session_id": session_id,
            "trigger": trigger,
            "status": "issued",
            "attempt": 1,
            "phrase": phrase,
            "issued_at": now,
            "expires_at": now + timedelta(seconds=TTL_S.get(trigger, 120)),
            "decision_id": decision_id,
        }
        await repo_voice.insert_challenge(row)
        return to_out(row)

    async def open_for_device(self, device_id: UUID) -> ChallengeOut | None:
        from app.core.runtime import rt

        rows = rt().repo_voice.open_for_device(device_id)
        return to_out(rows[0]) if rows else None

    async def refresh(
        self, challenge_id: UUID, *, trigger: str | None = None, decision_id: UUID | None = None
    ) -> ChallengeOut:
        current = state()
        if challenge_id in current.busy:
            raise HTTPException(409, "Challenge is being scored")
        row = await repo_voice.get_challenge(challenge_id)
        if row is None or row["status"] in {
            "verified",
            "blocked_spoof",
            "blocked_impostor",
            "expired",
            "cancelled",
        }:
            raise HTTPException(409, "Challenge is closed")
        current.busy.add(challenge_id)
        try:
            phrase = await fresh_material(challenge_id)
            latest = await repo_voice.get_challenge(challenge_id)
            if latest is None or latest["status"] in {
                "verified",
                "blocked_spoof",
                "blocked_impostor",
                "expired",
                "cancelled",
            }:
                raise HTTPException(409, "Challenge closed during refresh")
            selected_trigger = trigger or row["trigger"]
            fields: dict[str, Any] = {
                "phrase": phrase,
                "status": "issued",
                "attempt": 1,
                "prompt_first_get_at": None,
                "trigger": selected_trigger,
                "expires_at": utcnow() + timedelta(seconds=TTL_S.get(selected_trigger, 120)),
            }
            if decision_id:
                fields["decision_id"] = decision_id
            await repo_voice.update_challenge(challenge_id, **fields)
            row = await repo_voice.get_challenge(challenge_id)
            assert row is not None
            await events.challenge_status(challenge_id, row["status"], row["attempt"])
            return to_out(row)
        finally:
            current.busy.discard(challenge_id)

    async def cancel(self, challenge_id: UUID, reason: str) -> None:
        state(ready=False).prompt_ids.pop(challenge_id, None)
        await repo_voice.update_challenge(challenge_id, status="cancelled")
        row = await repo_voice.get_challenge(challenge_id)
        await events.challenge_status(challenge_id, "cancelled", row["attempt"] if row else 1)

    async def expire(self, challenge_id: UUID) -> None:
        state(ready=False).prompt_ids.pop(challenge_id, None)
        await repo_voice.update_challenge(challenge_id, status="expired")
        row = await repo_voice.get_challenge(challenge_id)
        await events.challenge_status(challenge_id, "expired", row["attempt"] if row else 1)


# Compatibility for code written against the CP0 stub class name.
FakeIssuer = VoiceIssuer
