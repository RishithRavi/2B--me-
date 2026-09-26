from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response

from app.auth import (
    SESSION_COOKIE,
    CurrentPrincipal,
    clear_session_cookie,
    issue_device_cookie,
    issue_session_cookie,
    principal_from_cookie,
    verify_password,
)
from app.core import totp
from app.core.runtime import rt
from twobme_common.types import DeviceOut, LoginIn, MeOut, OkOut

router = APIRouter(tags=["auth"])


def me_out(user, device=None) -> MeOut:  # noqa: ANN001
    d = None
    if device is not None:
        d = DeviceOut(id=device.id, label=device.label, pointer=device.pointer, mode=device.mode, locked=device.locked,
                      lock_reason=device.lock_reason, last_seen=device.last_seen)
    return MeOut(user_id=user.id, email=user.email, handle=user.handle, role=user.role,
                 totp_enrolled=totp.enrolled(user), device=d)


@router.post("/auth/login", response_model=MeOut)
async def login(body: LoginIn, response: Response) -> MeOut:
    """A web login never changes device trust (§5.3)."""
    r = rt()
    user = r.registry.user_by_email(body.email)
    if user is None or not verify_password(user.pw_hash, body.password):
        raise HTTPException(401, "wrong email or password")
    ws = r.registry.new_web_session(user.id)
    issue_session_cookie(response, ws)
    dev = r.registry.bound_device(user.id)
    if dev is not None:
        issue_device_cookie(response, dev.id)
    return me_out(user, dev)


@router.post("/auth/logout", response_model=OkOut)
async def logout(request: Request, response: Response) -> OkOut:
    p = principal_from_cookie(request.cookies.get(SESSION_COOKIE))
    if p and p.session:
        p.session.revoked = True
        rt().registry.mark_dirty()
    clear_session_cookie(response)  # the twobme_device binding cookie survives logout
    return OkOut()


@router.get("/me", response_model=MeOut)
async def me(p: CurrentPrincipal) -> MeOut:
    return me_out(p.user, rt().registry.bound_device(p.user.id))
