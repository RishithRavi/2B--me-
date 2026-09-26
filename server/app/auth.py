"""Auth (§5.3, §6 A1): argon2 passwords, signed httpOnly session cookies, hashed device tokens.

A web login never changes device trust. Admin cookie sessions are observer sessions: never
revoked by device locks and never anchor trust. BLOCK_* revokes only the subject user's sessions
(via `users.sessions_revoked_at`), and the `twobme_device` binding cookie survives logout/revocation.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated
from uuid import UUID

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from fastapi import Depends, Header, HTTPException, Request, Response, WebSocket
from itsdangerous import BadSignature, URLSafeTimedSerializer

from app.config import get_settings
from app.core.registry import Device, User, WebSession
from app.core.runtime import rt

SESSION_COOKIE = "twobme_session"
DEVICE_COOKIE = "twobme_device"
SESSION_MAX_AGE = 7 * 24 * 3600
DEVICE_MAX_AGE = 30 * 24 * 3600

_ph = PasswordHasher()


def hash_password(pw: str) -> str:
    return _ph.hash(pw)


def verify_password(pw_hash: str, pw: str) -> bool:
    try:
        return _ph.verify(pw_hash, pw)
    except (VerifyMismatchError, InvalidHashError):
        return False


def _serializer(salt: str) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().session_secret, salt=salt)


@dataclass
class Principal:
    user: User
    session: WebSession | None  # None when authenticated by X-Admin-Token

    @property
    def is_admin(self) -> bool:
        return self.user.role == "admin"

    @property
    def sid(self) -> str | None:
        return self.session.sid if self.session else None

    @property
    def session_created_at(self) -> datetime | None:
        return self.session.created_at if self.session else None


def issue_session_cookie(resp: Response, ws: WebSession) -> None:
    s = get_settings()
    token = _serializer("session").dumps({"sid": ws.sid, "uid": str(ws.user_id)})
    resp.set_cookie(SESSION_COOKIE, token, max_age=SESSION_MAX_AGE, httponly=True, samesite="lax",
                    secure=s.cookie_secure, path="/")


def issue_device_cookie(resp: Response, device_id: UUID) -> None:
    s = get_settings()
    token = _serializer("device").dumps(str(device_id))
    resp.set_cookie(DEVICE_COOKIE, token, max_age=DEVICE_MAX_AGE, httponly=True, samesite="lax",
                    secure=s.cookie_secure, path="/")


def clear_session_cookie(resp: Response) -> None:
    resp.delete_cookie(SESSION_COOKIE, path="/")


def principal_from_cookie(cookie: str | None) -> Principal | None:
    if not cookie:
        return None
    try:
        data = _serializer("session").loads(cookie, max_age=SESSION_MAX_AGE)
    except BadSignature:
        return None
    reg = rt().registry
    ws = reg.web_sessions.get(data.get("sid", ""))
    if ws is None or ws.revoked or str(ws.user_id) != data.get("uid"):
        return None
    user = reg.users.get(ws.user_id)
    if user is None:
        return None
    if user.role != "admin" and user.sessions_revoked_at and ws.created_at <= user.sessions_revoked_at:
        return None
    return Principal(user=user, session=ws)


def device_id_from_cookie(cookie: str | None) -> UUID | None:
    if not cookie:
        return None
    try:
        return UUID(_serializer("device").loads(cookie, max_age=DEVICE_MAX_AGE))
    except (BadSignature, ValueError):
        return None


def _admin_principal() -> Principal | None:
    admin = next((u for u in rt().registry.users.values() if u.role == "admin"), None)
    return Principal(user=admin, session=None) if admin else None


async def optional_principal(request: Request) -> Principal | None:
    return principal_from_cookie(request.cookies.get(SESSION_COOKIE))


async def current_principal(request: Request) -> Principal:
    # an explicit, valid X-Admin-Token wins (attack tool, scripts); otherwise the cookie session
    tok = request.headers.get("x-admin-token")
    s = get_settings()
    p = None
    if tok and s.admin_token and secrets.compare_digest(tok, s.admin_token):
        p = _admin_principal()
    if p is None:
        p = principal_from_cookie(request.cookies.get(SESSION_COOKIE))
    if p is None:
        raise HTTPException(401, "not logged in")
    return p


async def require_admin(p: Annotated[Principal, Depends(current_principal)]) -> Principal:
    if not p.is_admin:
        raise HTTPException(403, "admin only")
    return p


async def require_demo(p: Annotated[Principal, Depends(current_principal)]) -> Principal:
    if not get_settings().demo_mode:
        raise HTTPException(404, "demo mode off")
    return p


async def require_demo_admin(p: Annotated[Principal, Depends(require_admin)]) -> Principal:
    if not get_settings().demo_mode:
        raise HTTPException(404, "demo mode off")
    return p


def device_from_bearer_value(authorization: str | None) -> Device:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "missing device token")
    d = rt().registry.device_by_token(authorization.split(" ", 1)[1].strip())
    if d is None:
        raise HTTPException(401, "bad device token")
    return d


async def device_from_bearer(authorization: Annotated[str | None, Header()] = None) -> Device:
    return device_from_bearer_value(authorization)


def ws_principal(ws: WebSocket) -> Principal | None:
    return principal_from_cookie(ws.cookies.get(SESSION_COOKIE))


def can_see_device(p: Principal, device: Device) -> bool:
    return p.is_admin or device.user_id == p.user.id


CurrentPrincipal = Annotated[Principal, Depends(current_principal)]
AdminPrincipal = Annotated[Principal, Depends(require_admin)]
DemoAdmin = Annotated[Principal, Depends(require_demo_admin)]
DemoPrincipal = Annotated[Principal, Depends(require_demo)]
AgentDevice = Annotated[Device, Depends(device_from_bearer)]
