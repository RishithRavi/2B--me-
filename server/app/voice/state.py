"""Per-app state; restarting an app cannot reuse a previous model or enrollment."""

import asyncio
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from fastapi import HTTPException

from app.core.runtime import rt
from app.voice.config import VoiceSettings


@dataclass
class VoiceState:
    settings: VoiceSettings
    mode: str
    pipeline: Any = None
    prompts: Any = None
    ready: bool = False
    # A single worker owns this state. Changes before an await are atomic.
    issuance_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    busy: set[UUID] = field(default_factory=set)
    enrollments: dict = field(default_factory=dict)
    prompt_ids: dict = field(default_factory=dict)
    # Bound uploaded PCM and pending model work across all users.
    inference_slots: asyncio.Semaphore = field(default_factory=lambda: asyncio.Semaphore(2))


def state(*, ready: bool = True) -> VoiceState:
    value = rt().extras.get("voice_service")
    if value is None or (ready and not value.ready):
        raise HTTPException(503, "Voice service is not ready")
    return value
