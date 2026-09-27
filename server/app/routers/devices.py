from __future__ import annotations

from fastapi import APIRouter

from app.auth import AgentDevice, CurrentPrincipal
from app.core.runtime import rt
from twobme_common.types import AgentTicksIn, AgentTicksOut, DeviceOut, DeviceRegisterIn, DeviceRegisterOut

router = APIRouter(tags=["devices"])


@router.post("/devices/register", response_model=DeviceRegisterOut)
async def register(body: DeviceRegisterIn, p: CurrentPrincipal) -> DeviceRegisterOut:
    r = rt()
    # §5.3/§5.4: a new device of a user who already has an active model starts in monitor at 0.30 (a stolen
    # cookie can't register an anchored enrolling device); a user's first device enrolls (learning)
    mode = "monitor" if r.models.scorer(p.user.id) is not None else "enroll"
    dev, token = r.registry.register_device(
        p.user.id, body.label, body.os, body.pointer, body.display.model_dump() if body.display else None, mode=mode)
    r.hub.rt(dev)  # anchors from trust_config: new_device_monitor 0.30 / new_device_enroll (learning)
    r.registry.save_mirror(force=True)
    return DeviceRegisterOut(device_id=dev.id, device_token=token)


@router.get("/devices", response_model=list[DeviceOut])
async def list_devices(p: CurrentPrincipal) -> list[DeviceOut]:
    reg = rt().registry
    devs = reg.devices.values() if p.is_admin else reg.devices_of(p.user.id)
    return [DeviceOut(id=d.id, label=d.label, pointer=d.pointer, mode=d.mode, locked=d.locked,
                      lock_reason=d.lock_reason, last_seen=d.last_seen) for d in devs]


@router.post("/agent/ticks", response_model=AgentTicksOut)
async def agent_ticks(body: AgentTicksIn, dev: AgentDevice) -> AgentTicksOut:
    """HTTPS fallback while the WS is down, so a Wi-Fi hiccup doesn't cost A the binding."""
    hub = rt().hub
    drt = hub.rt(dev)
    acc = dup = 0
    for t in sorted(body.ticks, key=lambda t: (str(t.run_id), t.seq)):
        res = await hub.ingest_tick(drt, t)
        if res == "duplicate":
            dup += 1
        else:
            acc += 1
    return AgentTicksOut(accepted=acc, duplicates=dup)
