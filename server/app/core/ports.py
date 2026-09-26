"""Interfaces between the hub (Claude), voice (Codex 2) and models (Codex 1). §5.6.

ChallengeIssuer is implemented by server/app/voice (the A0 stub is `FakeIssuer`; Codex 2 owns it after CP0).
The hub enforces the one-open-challenge-per-device rule: it calls `issue()` only when
`open_for_device()` returns None, and `refresh()` to consume an armed challenge for a step-up
(same challenge_id, fresh phrase).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal, Protocol, runtime_checkable
from uuid import UUID

from twobme_common.types import Block, BlockScore, ChallengeOut, ChallengeTrigger, TrustState

IssueTrigger = Literal["proactive", "step_up", "unlock", "redteam", "sandbox"]


@runtime_checkable
class ChallengeIssuer(Protocol):
    async def issue(
        self,
        *,
        device_id: UUID | None,
        subject_user_id: UUID,
        session_id: UUID | None,
        trigger: IssueTrigger,
        decision_id: UUID | None,
    ) -> ChallengeOut:
        """Create a challenge row (status `issued`, attempt 1) with a fresh phrase and its prompt."""
        ...

    async def open_for_device(self, device_id: UUID) -> ChallengeOut | None:
        """The device's open (non-terminal, unexpired) proactive/step_up/unlock challenge, if any."""
        ...

    async def refresh(
        self,
        challenge_id: UUID,
        *,
        trigger: ChallengeTrigger | None = None,
        decision_id: UUID | None = None,
    ) -> ChallengeOut:
        """Same challenge_id, fresh phrase + prompt (used when a step-up consumes an armed challenge)."""
        ...

    async def cancel(self, challenge_id: UUID, reason: str) -> None:
        """Mark cancelled (demo reset / rearm). Must call core.events.challenge_status."""
        ...

    async def expire(self, challenge_id: UUID) -> None:
        """Mark expired (unanswered proactive after 180 s). Must call core.events.challenge_status."""
        ...


class Scorer(Protocol):
    """twobme_ml.UserModel (Codex 1) or the server's fallback model."""

    version: int

    def score_block(self, block: Block) -> BlockScore | None: ...


class TrustEngineLike(Protocol):
    """twobme_ml.trust.TrustEngine (Codex 1) or core.trust_fallback.TrustEngine."""

    def on_tick(self, t_end: float, idle_s: float, scores: list[BlockScore]) -> TrustState: ...

    def anchor(self, p: float) -> None: ...

    def to_dict(self) -> dict[str, Any]: ...


class ModelBackend(Protocol):
    name: str

    def train(self, df: Any, cfg: Any) -> Any: ...

    def load(self, d: Path) -> Scorer: ...

    def save(self, model: Any, d: Path) -> None: ...
