"""STUB (A0) — owner: Codex 2 after CP0. Real startup preloads ECAPA + DF_Arena + the prompt pool and
runs one warm-up inference; the app lifespan awaits it with a timeout before /healthz reports ok."""

from __future__ import annotations

import asyncio


async def startup() -> None:
    await asyncio.sleep(0)
