"""Stub-voice honesty and the operator's demo-decision control (§5.3 "Voice outcome", §8 C2 "Stub honesty").

In `VOICE_MODE=stub` the voice router returns a canned `VoiceResult` chosen by the `X-Fake-Decision` header.
That header must never be a user-controlled switch (a stolen session could simply send VERIFY), so an ASGI
middleware in front of the whole API (stub mode only):

1. strips a client `X-Fake-Decision` from EVERY HTTP request unless the principal is admin (admin cookie session
   or a valid `X-Admin-Token`) — fail closed, whatever path spelling reaches the voice router (FastAPI accepts
   `{challenge_id}` as dashed, 32-hex, braced or `urn:uuid:` UUIDs);
2. on `POST /api/voice/challenges/{id}/response` (any spelling `uuid.UUID()` parses), when no admin header
   remains, injects the operator's sticky per-device choice from `POST /api/demo/voice-outcome`;
3. otherwise injects a label-aware default: `BLOCK_IMPOSTOR` while the device is labelled impostor (a takeover
   was marked), else `VERIFY`.

Unlock challenges only ever get an owner-safe outcome (`VERIFY`, or a `FALLBACK_MFA` override): they need a fresh
password login made after the lock, and neither a stale takeover label nor a forgotten BLOCK override may keep the
returning owner locked out of a simulated check. A BLOCK_* override is consumed once it has locked the device, and
`/demo/reset` clears the device's override, so a preset for one beat never leaks into the next run.

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
# same segment rule as Starlette's `{challenge_id}` ([^/]+); anchored at the end so a root_path prefix still matches
_RESPONSE_PATH = re.compile(r"/api/voice/challenges/([^/]+)/response/?$")
UNLOCK_SAFE = ("VERIFY", "FALLBACK_MFA")
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


def clear_override(device_id: UUID, why: str, actor: str | None = None) -> str | None:
    """Drop the device's override (reset, or a BLOCK_* that has done its job); a feed line + audit row say so."""
    ov = overrides().pop(device_id, None)
    if ov is None:
        return None
    r = rt()
    drt = r.hub.devices.get(device_id)
    text = f"Demo voice outcome {ov} cleared ({why})"
    audit = r.extras.get("audit")
    if audit is not None:
        audit.emit("admin_action", text, device_id=device_id, severity=1, actor=actor)
    if drt is not None:
        r.hub.feed(drt, "operator", text, 1)
    return ov


def parse_challenge_id(raw: str) -> UUID | None:
    """Every spelling pydantic accepts for a UUID path param (dashed, 32-hex, braced, urn:uuid:) parses here."""
    try:
        return UUID(raw)
    except ValueError:
        return None


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


async def choose(challenge_id: UUID) -> tuple[str, UUID | None, bool]:
    """(decision, device_id, from_override): the operator override for the challenge's device, else the
    label-aware default. Unlock challenges only take an owner-safe outcome."""
    r = rt()
    row = await r.repo_voice.get_challenge(challenge_id)
    if row is None:
        return "VERIFY", None, False  # the router answers 404 anyway
    device_id = row.get("device_id")
    ov = get_override(device_id)
    if row.get("trigger") == "unlock":
        return (ov, device_id, True) if ov in UNLOCK_SAFE else ("VERIFY", device_id, False)
    if ov:
        return ov, device_id, True
    drt = r.hub.devices.get(device_id) if device_id is not None else None
    if drt is not None and drt.label == "impostor":
        return "BLOCK_IMPOSTOR", device_id, False
    return "VERIFY", device_id, False


async def default_decision(challenge_id: UUID) -> str:
    return (await choose(challenge_id))[0]


def _locked(device_id: UUID | None) -> bool | None:
    if device_id is None:
        return None
    drt = rt().hub.devices.get(device_id)
    return None if drt is None else bool(drt.dev.locked)


def _strip(scope: dict) -> dict:
    return dict(scope, headers=[(k, v) for k, v in scope.get("headers") or [] if k != FAKE_HEADER])


class VoiceDemoMiddleware:
    """Pure ASGI (keeps multipart streaming untouched): only the request headers are rewritten."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        consumed: UUID | None = None
        if scope.get("type") == "http":
            try:
                scope, consumed = await self._rewrite(scope)
            except Exception:  # never fail open to a client-chosen header: strip it
                log.exception("voice demo middleware failed; stripping X-Fake-Decision")
                scope, consumed = _strip(scope), None
        was_locked = _locked(consumed)
        await self.app(scope, receive, send)
        if consumed is not None and was_locked is False and _locked(consumed):
            try:
                if (get_override(consumed) or "").startswith("BLOCK"):
                    clear_override(consumed, "used: the simulated block locked the device")
            except Exception:
                log.exception("voice demo override bookkeeping failed")

    async def _rewrite(self, scope: dict) -> tuple[dict, UUID | None]:
        """-> (scope, device whose BLOCK_* override was injected, if any)."""
        headers = list(scope.get("headers") or [])
        has_fake = any(k == FAKE_HEADER for k, _ in headers)
        m = _RESPONSE_PATH.search(scope.get("path", "")) if scope.get("method") == "POST" else None
        if not has_fake and m is None:
            return scope, None
        if voice_mode() != "stub":
            return scope, None  # real mode: Codex 2's router rejects any fake header with 400
        admin_fake = has_fake and _is_admin(headers)
        if has_fake and not admin_fake:
            scope, headers = _strip(scope), [(k, v) for k, v in headers if k != FAKE_HEADER]
        cid = parse_challenge_id(m.group(1)) if m is not None else None
        if cid is None or admin_fake:
            return scope, None  # an admin's explicit choice (scripts, tests, the attack-tool rehearsal) wins
        decision, device_id, from_override = await choose(cid)
        headers.append((FAKE_HEADER, decision.encode("latin-1")))
        consumed = device_id if from_override and decision.startswith("BLOCK") else None
        return dict(scope, headers=headers), consumed
