"""Process-wide singletons (single uvicorn worker by design, §6 A1). Set by main.lifespan."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.config import Settings
    from app.core.hub import DeviceHub
    from app.core.live import LiveBus
    from app.core.models import ModelManager
    from app.core.ports import ChallengeIssuer
    from app.core.registry import Registry
    from app.db.pool import Db
    from app.db.repo_voice import RepoVoice
    from app.db.writer import Writer


@dataclass
class Runtime:
    settings: Settings
    db: Db
    writer: Writer
    registry: Registry
    live: LiveBus
    models: ModelManager
    hub: DeviceHub
    issuer: ChallengeIssuer
    repo_voice: RepoVoice
    started_at: float = field(default_factory=time.time)
    voice_warm: bool = False
    extras: dict[str, Any] = field(default_factory=dict)


_RT: Runtime | None = None


def set_runtime(r: Runtime | None) -> None:
    global _RT
    _RT = r


def rt() -> Runtime:
    if _RT is None:
        raise RuntimeError("runtime not initialised (app lifespan not running)")
    return _RT
