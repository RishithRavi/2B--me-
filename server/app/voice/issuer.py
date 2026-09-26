"""STUB (A0) — owner: Codex 2 after CP0. FakeIssuer with a fixed phrase; implements core.ports.ChallengeIssuer."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any
from uuid import UUID

from app.config import get_settings
from app.core import events
from app.db import repo_voice
from twobme_common.types import ChallengeOut, utcnow

FIXED_PHRASE = "amber river quiet falcon lantern"
TTL_S = {"proactive": 180, "step_up": 120, "unlock": 120, "redteam": 120, "sandbox": 120}


def to_out(row: dict[str, Any]) -> ChallengeOut:
    s = get_settings()
    return ChallengeOut(
        challenge_id=row["id"], trigger=row["trigger"], status=row["status"], attempt=row["attempt"],
        phrase=row["phrase"], prompt_url=f"/api/voice/challenges/{row['id']}/prompt.mp3",
        expires_at=row.get("expires_at"), verify_url=s.verify_url(row["id"]),
    )


class FakeIssuer:
    async def issue(self, *, device_id: UUID | None, subject_user_id: UUID, session_id: UUID | None,
                    trigger: str, decision_id: UUID | None) -> ChallengeOut:
        now = utcnow()
        row = {
            "id": uuid.uuid4(), "user_id": subject_user_id, "device_id": device_id, "session_id": session_id,
            "trigger": trigger, "status": "issued", "attempt": 1, "phrase": FIXED_PHRASE, "issued_at": now,
            "expires_at": now + timedelta(seconds=TTL_S.get(trigger, 120)), "decision_id": decision_id,
        }
        await repo_voice.insert_challenge(row)
        return to_out(row)

    async def open_for_device(self, device_id: UUID) -> ChallengeOut | None:
        from app.core.runtime import rt

        rows = rt().repo_voice.open_for_device(device_id)
        return to_out(rows[0]) if rows else None

    async def refresh(self, challenge_id: UUID, *, trigger: str | None = None,
                      decision_id: UUID | None = None) -> ChallengeOut:
        fields: dict[str, Any] = {"phrase": FIXED_PHRASE, "status": "issued"}
        if trigger:
            fields["trigger"] = trigger
            fields["expires_at"] = utcnow() + timedelta(seconds=TTL_S.get(trigger, 120))
        if decision_id:
            fields["decision_id"] = decision_id
        await repo_voice.update_challenge(challenge_id, **fields)
        row = await repo_voice.get_challenge(challenge_id)
        assert row is not None
        await events.challenge_status(challenge_id, row["status"], row["attempt"])
        return to_out(row)

    async def cancel(self, challenge_id: UUID, reason: str) -> None:
        await repo_voice.update_challenge(challenge_id, status="cancelled")
        row = await repo_voice.get_challenge(challenge_id)
        await events.challenge_status(challenge_id, "cancelled", row["attempt"] if row else 1)

    async def expire(self, challenge_id: UUID) -> None:
        await repo_voice.update_challenge(challenge_id, status="expired")
        row = await repo_voice.get_challenge(challenge_id)
        await events.challenge_status(challenge_id, "expired", row["attempt"] if row else 1)
