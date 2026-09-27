"""WebSockets: /ws/agent (device token in `hello`) and /ws/live (cookie; `?scope=org` = admin panel). §5.2."""

from __future__ import annotations

import asyncio
import json
import logging
from uuid import UUID

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from app.auth import ws_principal
from app.core.audit import is_synthetic_email
from app.core.live import Subscriber
from app.core.registry import Device, Registry
from app.core.runtime import rt
from twobme_common.types import AgentError, AgentMessage, Hello

log = logging.getLogger("twobme.ws")
router = APIRouter()
_agent_msg = TypeAdapter(AgentMessage)


@router.websocket("/ws/agent")
async def ws_agent(ws: WebSocket) -> None:
    await ws.accept()
    r = rt()
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=15)
        hello = Hello.model_validate_json(raw)
    except (TimeoutError, ValidationError, WebSocketDisconnect, ValueError) as e:
        log.info("agent rejected before hello: %s", type(e).__name__)
        await _close(ws, 4401, "hello required")
        return
    dev = r.registry.device_by_token(hello.device_token)
    if dev is None:
        await _close(ws, 4401, "bad device token")
        return
    if hello.schema_version != r.hub.spec.schema_version:
        await ws.send_text(AgentError(code="schema_version",
                                      detail=f"server speaks v{r.hub.spec.schema_version}").model_dump_json())
    drt = await r.hub.agent_hello(dev, hello, ws)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = _agent_msg.validate_json(raw)
            except ValidationError as e:
                # never echo the payload back or log it (privacy): only the error locations
                locs = sorted({".".join(str(x) for x in err["loc"][:3]) for err in e.errors()})[:8]
                await ws.send_text(AgentError(code="bad_message", detail=f"invalid fields: {locs}").model_dump_json())
                continue
            try:
                await r.hub.agent_message(drt, msg)
            except Exception:
                log.exception("agent message failed")
                await ws.send_text(AgentError(code="server_error").model_dump_json())
    except WebSocketDisconnect:
        pass
    except RuntimeError:
        pass
    finally:
        r.hub.agent_disconnected(drt, ws)


@router.websocket("/ws/live")
async def ws_live(ws: WebSocket) -> None:
    p = ws_principal(ws)
    if p is None:
        await ws.accept()
        await _close(ws, 4401, "login required")
        return
    await ws.accept()
    r = rt()
    if ws.query_params.get("scope") == "org":
        # admin/org panel (§2.4): every device's events plus `audit` rows; no device filter and no snapshot on
        # open (the client fetches GET /api/admin/roster)
        if not p.is_admin:
            await _close(ws, 4403, "admin only")
            return
        await r.live.serve(Subscriber(ws=ws, user_id=p.user.id, is_admin=True, device_id=None))
        return
    want = ws.query_params.get("device_id")
    dev = None
    if want:
        try:
            dev = r.registry.devices.get(UUID(want))
        except ValueError:
            dev = None
        if dev is not None and not (p.is_admin or dev.user_id == p.user.id):
            dev = None
    if dev is None:
        if p.is_admin:
            dev = default_admin_device(r.registry)
        else:
            dev = r.registry.bound_device(p.user.id)
    sub = Subscriber(ws=ws, user_id=p.user.id, is_admin=p.is_admin, device_id=dev.id if dev else None)

    async def on_open(s: Subscriber) -> None:
        drt = r.hub.rt(dev) if dev else None
        r.live.send_to(s, "snapshot", dev.id if dev else None, r.hub.snapshot(drt))

    await r.live.serve(sub, on_open)


def default_admin_device(reg: Registry) -> Device | None:
    """The observer dashboard's device when the client names none: the most recently seen REAL device, so the
    org-demo employees (scripts/core_org_demo.py ticks 19 of them every 5 s) never displace A's laptop."""
    devs = list(reg.devices.values())
    if not devs:
        return None

    def key(d: Device) -> tuple[bool, float]:
        u = reg.users.get(d.user_id)
        return (not is_synthetic_email(u.email if u else None), d.last_seen.timestamp() if d.last_seen else 0.0)

    return max(devs, key=key)


async def _close(ws: WebSocket, code: int, reason: str) -> None:
    try:
        await ws.send_text(json.dumps({"type": "error", "code": code, "detail": reason}))
        await ws.close(code=code, reason=reason)
    except Exception:
        pass
