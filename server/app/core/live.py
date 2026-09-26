"""/ws/live fan-out (§5.2). A user sees their own devices; admin (observer) sees all.

`publish()` is synchronous and never blocks the hub: each subscriber has a bounded queue that
drops its oldest event when full; a per-subscriber task does the actual socket writes.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from twobme_common.types import LiveEnvelope, iso_ms, utcnow

log = logging.getLogger("twobme.live")

QUEUE_MAX = 500


def envelope(type_: str, device_id: UUID | None, data: BaseModel | dict | None) -> str:
    if isinstance(data, BaseModel):
        payload: Any = json.loads(data.model_dump_json(by_alias=True))
    else:
        payload = data or {}
    return json.dumps({"type": type_, "device_id": str(device_id) if device_id else None,
                       "t": iso_ms(utcnow()), "data": payload})


@dataclass(eq=False)
class Subscriber:
    ws: WebSocket
    user_id: UUID
    is_admin: bool
    device_id: UUID | None
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(QUEUE_MAX))
    dropped: int = 0

    def offer(self, msg: str) -> None:
        if self.queue.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self.queue.get_nowait()
            self.dropped += 1
        self.queue.put_nowait(msg)


class LiveBus:
    def __init__(self) -> None:
        self.subs: set[Subscriber] = set()
        # device_id -> monotonic time a non-admin browser last had /ws/live open for it
        self.browser_seen: dict[UUID, float] = {}

    def publish(self, device_id: UUID | None, owner_id: UUID | None, type_: str,
                data: BaseModel | dict | None) -> None:
        if not self.subs:
            return
        msg = envelope(type_, device_id, data)
        for s in list(self.subs):
            if s.device_id is not None and device_id is not None and s.device_id != device_id:
                continue
            if s.is_admin or (owner_id is not None and s.user_id == owner_id):
                s.offer(msg)

    def send_to(self, sub: Subscriber, type_: str, device_id: UUID | None, data: BaseModel | dict | None) -> None:
        sub.offer(envelope(type_, device_id, data))

    def browser_recent(self, device_id: UUID, within_s: float = 15.0) -> bool:
        now = time.monotonic()
        for s in self.subs:
            if not s.is_admin and s.device_id == device_id:
                self.browser_seen[device_id] = now
        t = self.browser_seen.get(device_id)
        return t is not None and now - t <= within_s

    async def serve(self, sub: Subscriber, on_open: Any = None) -> None:
        self.subs.add(sub)
        if not sub.is_admin and sub.device_id is not None:
            self.browser_seen[sub.device_id] = time.monotonic()
        sender = asyncio.create_task(self._sender(sub))
        try:
            if on_open is not None:
                await on_open(sub)
            while True:
                msg = await sub.ws.receive_text()
                if msg == "ping":
                    sub.offer(json.dumps({"type": "pong", "t": iso_ms(utcnow())}))
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            self.subs.discard(sub)
            if not sub.is_admin and sub.device_id is not None:
                self.browser_seen[sub.device_id] = time.monotonic()
            sender.cancel()

    async def _sender(self, sub: Subscriber) -> None:
        try:
            while True:
                msg = await sub.queue.get()
                await sub.ws.send_text(msg)
        except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
            return
        except Exception as e:  # socket gone
            log.debug("live sender stopped: %s", e)


__all__ = ["LiveBus", "Subscriber", "envelope", "LiveEnvelope"]
