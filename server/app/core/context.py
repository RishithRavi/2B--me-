"""ContextStore (§12, Backboard.io deferred). Only the protocol + a no-op implementation ship.

A future BackboardContextStore would call https://app.backboard.io/api with `X-API-Key`, one assistant
per user, always pass the memory mode explicitly, store only categories and hashed IDs (never plaintext
app names), and run off the hot path.
"""

from __future__ import annotations

from typing import Protocol
from uuid import UUID


class ContextStore(Protocol):
    async def record(self, user_id: UUID, kind: str, text: str) -> None: ...

    async def recall(self, user_id: UUID, query: str) -> list[str]: ...


class NoopContextStore:
    async def record(self, user_id: UUID, kind: str, text: str) -> None:
        return None

    async def recall(self, user_id: UUID, query: str) -> list[str]:
        return []
