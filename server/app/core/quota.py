"""ElevenLabs quota for /status and the dashboard health pill (§11.1: amber at 80%).

Polls GET /v1/user/subscription every 5 minutes when ELEVENLABS_API_KEY is set; never on the hot path.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

log = logging.getLogger("twobme.quota")
URL = "https://api.elevenlabs.io/v1/user/subscription"


async def fetch(api_key: str) -> dict[str, Any] | None:
    try:
        async with httpx.AsyncClient(timeout=8) as c:
            r = await c.get(URL, headers={"xi-api-key": api_key})
            r.raise_for_status()
            d = r.json()
    except Exception as e:
        log.info("elevenlabs quota check failed: %s", e)
        return None
    used, limit = d.get("character_count"), d.get("character_limit")
    frac = (used / limit) if used is not None and limit else None
    return {"tier": d.get("tier"), "character_count": used, "character_limit": limit,
            "remaining": (limit - used) if used is not None and limit else None, "used_frac": frac,
            "next_reset_unix": d.get("next_character_count_reset_unix")}


async def poll_forever(api_key: str, extras: dict[str, Any], every_s: float = 300.0) -> None:
    while True:
        info = await fetch(api_key)
        if info is not None:
            extras["elevenlabs"] = info
            extras["elevenlabs_quota"] = info["used_frac"]
        await asyncio.sleep(every_s)
