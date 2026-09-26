"""Stub-voice honesty and the operator's demo-decision control (§5.3 "Voice outcome", §8 C2 "Stub honesty").

In `VOICE_MODE=stub` the voice router returns a canned `VoiceResult` chosen by the `X-Fake-Decision` header.
That header must never be a user-controlled switch (a stolen session could simply send VERIFY), so an ASGI
middleware in front of `POST /api/voice/challenges/{id}/response`:

1. strips a client `X-Fake-Decision` unless the principal is admin (admin cookie session or a valid
   `X-Admin-Token`);
2. when no (admin) header remains, injects the operator's sticky per-device choice from
   `POST /api/demo/voice-outcome`;
3. otherwise injects a label-aware default: `BLOCK_IMPOSTOR` while the device is labelled impostor (a takeover
   was marked), else `VERIFY`. Unlock challenges default to `VERIFY`: they need a fresh password login made after
   the lock, and a stale takeover label must not keep the returning owner locked out of a simulated check.

In real voice mode the middleware does nothing (Codex 2's router rejects any fake header with 400).
Every stub result is published with `VoiceResultLive.simulated = True` (hub.on_voice_decided).
"""

from __future__ import annotations

import logging
import re
import secrets
from typing import Any
from uuid import UUID

from starlette.requests import cookie_parser

from app.core.runtime import rt

log = logging.getLogger("twobme.voice_demo")

FAKE_HEADER = b"x-fake-decision"
_RESPONSE_PATH = re.compile(r"^/api/voice/challenges/([0-9a-fA-F-]{36})/response/?$")
OVERRIDES_KEY = "voice_outcome_overrides"


def voice_mode() -> str:
    """'stub' | 'real' — what the voice service actually runs. Falls back to 'stub' on any error."""
    try:
        current = rt().extras.get("voice_service")
        if current is not None and getattr(current, "mode", None) in ("stub", "real"):
            return current.mode
    except RuntimeError:
        pass
    try:
        from app.config import get_settings
        from app.voice.config import VoiceSettings

        return VoiceSettings().mode(demo=get_settings().demo_mode)
    except Exception:
        return "stub"


def overrides() -> dict[UUID, str]:
    return rt().extras.setdefault(OVERRIDES_KEY, {})


def set_override(device_id: UUID, decision: str | None) -> None:
    ov = overrides()
    if decision is None:
        ov.pop(device_id, None)
    else:
        ov[device_id] = decision


def get_override(device_id: UUID | None) -> str | None:
    if device_id is None:
        return None
    return overrides().get(device_id)


def _is_admin(headers: list[tuple[bytes, bytes]]) -> bool:
    from app.auth import SESSION_COOKIE, principal_from_cookie
    from app.config import get_settings

    s = get_settings()
    cookie = b""
    for k, v in headers:
        if k == b"x-admin-token":
            tok = v.decode("latin-1")
            if s.admin_token and secrets.compare_digest(tok, s.admin_token):
                return True
        elif k == b"cookie":
            cookie = v
    if cookie:
        p = principal_from_cookie(cookie_parser(cookie.decode("latin-1")).get(SESSION_COOKIE))
        if p is not None and p.is_admin:
            return True
    return False


async def default_decision(challenge_id: UUID) -> str:
    """Operator override for the challenge's device, else the label-aware default."""
    r = rt()
    row = await r.repo_voice.get_challenge(challenge_id)
    if row is None:
        return "VERIFY"  # the router answers 404 anyway
    device_id = row.get("device_id")
    ov = get_override(device_id)
    if ov:
        return ov
    if row.get("trigger") == "unlock":
        return "VERIFY"
    drt = r.hub.devices.get(device_id) if device_id is not None else None
    if drt is not None and drt.label == "impostor":
        return "BLOCK_IMPOSTOR"
    return "VERIFY"


class VoiceDemoMiddleware:
    """Pure ASGI (keeps multipart streaming untouched): only the request headers are rewritten."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") == "http" and scope.get("method") == "POST":
            m = _RESPONSE_PATH.match(scope.get("path", ""))
            if m is not None:
                try:
                    scope = await self._rewrite(scope, UUID(m.group(1)))
                except Exception:  # never fail open to a client-chosen header: strip it
                    log.exception("voice demo middleware failed; stripping X-Fake-Decision")
                    scope = dict(scope, headers=[(k, v) for k, v in scope["headers"] if k != FAKE_HEADER])
        await self.app(scope, receive, send)

    async def _rewrite(self, scope: dict, challenge_id: UUID) -> dict:
        if voice_mode() != "stub":
            return scope
        headers = list(scope.get("headers") or [])
        client_fake = [v for k, v in headers if k == FAKE_HEADER]
        if client_fake and _is_admin(headers):
            return scope  # an admin's explicit choice (scripts, tests, the attack-tool rehearsal) wins
        headers = [(k, v) for k, v in headers if k != FAKE_HEADER]
        decision = await default_decision(challenge_id)
        headers.append((FAKE_HEADER, decision.encode("latin-1")))
        return dict(scope, headers=headers)
