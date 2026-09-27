"""History (Tiger), reports, health. History endpoints serve the last cached payload when Tiger is
down (degraded mode) with `X-Cache: stale`."""

from __future__ import annotations

import json
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.auth import AdminPrincipal, CurrentPrincipal
from app.core.runtime import rt
from app.db import history as H
from twobme_common.paths import contracts_dir
from twobme_common.types import (
    AnomalyRow,
    BaselineOut,
    DriftRow,
    OkOut,
    SessionRow,
    StatusOut,
    TigerStats,
    TrustSeries,
    utcnow,
)

router = APIRouter(tags=["history"])
_cache: dict[str, Any] = {}


def _cached(key: str, value: Any, response: Response) -> Any:
    if value is not None:
        _cache[key] = value
        return value
    if key in _cache:
        response.headers["X-Cache"] = "stale"
        return _cache[key]
    raise HTTPException(503, "Tiger is unavailable and nothing is cached yet")


def _scope(p) -> UUID | None:  # noqa: ANN001
    return None if p.is_admin else p.user.id


@router.get("/history/sessions", response_model=list[SessionRow])
async def history_sessions(p: CurrentPrincipal, response: Response, limit: int = 30) -> Any:
    uid = _scope(p)
    return _cached(f"sessions:{uid}:{limit}", await H.sessions(rt().db, uid, min(limit, 200)), response)


@router.get("/history/trust", response_model=TrustSeries)
async def history_trust(p: CurrentPrincipal, response: Response, session_id: UUID | None = None,
                        device_id: UUID | None = None, start: datetime | None = None, end: datetime | None = None,
                        bucket: str | None = None) -> Any:
    r = rt()
    if session_id is not None:
        info = await H.session_info(r.db, session_id)
        if info is None:
            key = f"trust:{session_id}"
            return _cached(key, None, response)
        if not p.is_admin and info["user_id"] != p.user.id:
            raise HTTPException(404, "unknown session")
        device_id = info["device_id"]
        start = start or info["started_at"]
        end = end or info["ended_at"] or utcnow()
    else:
        if device_id is None:
            dev = r.registry.bound_device(p.user.id)
            if dev is None:
                raise HTTPException(404, "no device")
            device_id = dev.id
        dev = r.registry.devices.get(device_id)
        if dev is None or not (p.is_admin or dev.user_id == p.user.id):
            raise HTTPException(404, "unknown device")
        end = end or utcnow()
        start = start or end - timedelta(hours=1)
    if bucket is not None and bucket not in {"10 seconds", "30 seconds", "1 minute", "5 minutes", "10 minutes",
                                              "1 hour"}:
        raise HTTPException(422, "bad bucket")
    key = f"trust:{session_id or device_id}:{bucket}"
    return _cached(key, await H.trust_series(r.db, device_id=device_id, session_id=session_id, start=start, end=end,
                                             bucket=bucket), response)


@router.get("/history/anomalies", response_model=list[AnomalyRow])
async def history_anomalies(p: CurrentPrincipal, response: Response, limit: int = 50) -> Any:
    uid = _scope(p)
    return _cached(f"anom:{uid}:{limit}", await H.anomalies(rt().db, uid, min(limit, 500)), response)


@router.get("/history/baseline", response_model=BaselineOut)
async def history_baseline(p: CurrentPrincipal, response: Response,
                           modality: Literal["keyboard", "mouse", "scroll", "workflow", "temporal"] = "keyboard",
                           session_id: UUID | None = None, user_id: UUID | None = None) -> Any:
    uid = user_id if (user_id and p.is_admin) else p.user.id
    if p.is_admin and user_id is None:
        # observer: default to the most recently seen device's owner
        devs = list(rt().registry.devices.values())
        if devs:
            uid = max(devs, key=lambda d: d.last_seen.timestamp() if d.last_seen else 0).user_id
    return _cached(f"base:{uid}:{modality}:{session_id}",
                   await H.baseline(rt().db, user_id=uid, modality=modality, session_id=session_id), response)


@router.get("/history/drift", response_model=list[DriftRow])
async def history_drift(p: CurrentPrincipal) -> list[DriftRow]:
    return []  # P1 (drift_30m) — first in the cut order


@router.get("/tiger/stats", response_model=TigerStats)
async def tiger_stats(response: Response) -> Any:
    st = await H.tiger_stats(rt().db)
    if st is None and "tiger" not in _cache:
        return TigerStats(ok=False)
    return _cached("tiger", st, response)


@router.post("/tiger/compress-now", response_model=OkOut)
async def compress_now(p: AdminPrincipal) -> OkOut:
    n = await H.compress_now(rt().db)
    if n is None:
        raise HTTPException(503, "Tiger is down")
    return OkOut(detail=f"compressed {n} chunk(s) older than 1 hour")


# --- reports -----------------------------------------------------------------------------------------
@router.get("/eval/report")
async def eval_report(kind: Literal["eval", "redteam", "hearsay"], sample: bool = False) -> Any:
    real = Path(rt().settings.reports_dir) / f"{kind}.json"
    if real.is_file():
        return JSONResponse(json.loads(real.read_text()))
    if sample:
        p = contracts_dir() / "fixtures" / "reports" / f"{kind}.json"
        return JSONResponse(json.loads(p.read_text()), headers={"X-Report-Sample": "1"})
    raise HTTPException(404, f"no {kind} report yet")


# --- health --------------------------------------------------------------------------------------------
class Healthz(BaseModel):
    ok: bool
    voice_warm: bool
    tiger: str


@router.get("/healthz", response_model=Healthz)
async def healthz(response: Response) -> Healthz:
    r = rt()
    if not r.voice_warm:
        response.status_code = 503
    return Healthz(ok=r.voice_warm, voice_warm=r.voice_warm, tiger="up" if r.db.up else "down")


@router.get("/status", response_model=StatusOut)
async def status() -> StatusOut:
    r = rt()
    online = sum(1 for d in r.hub.devices.values()
                 if d.agent_ws is not None or ((d.heartbeat_age() or 1e9) < 30))
    return StatusOut(
        ok=True, version=r.settings.version, uptime_s=round(time.time() - r.started_at, 1),
        tiger="up" if r.db.up else "down", voice_warm=r.voice_warm, demo_mode=r.settings.demo_mode,
        continuous_update=r.settings.continuous_update, writer=r.writer.stats(), devices_online=online,
        elevenlabs=r.extras.get("elevenlabs"),
        inference={"model_backend": r.models.backend_name, "trust_engine": _engine_kind(),
                   "explanations": "vultr" if r.extras.get("explainer_enabled") else "template"},
        voice_mode=_voice_mode(r.settings.demo_mode), model_backend=r.models.backend_name,
    )


def _voice_mode(demo: bool) -> str:
    """What the voice layer actually runs (stub results are badged "simulated"); "stub" on any error."""
    try:
        from app.voice.config import VoiceSettings

        mode = VoiceSettings().mode(demo=demo)
        return mode if mode in ("stub", "real") else "stub"
    except Exception:
        return "stub"


def _engine_kind() -> str:
    from app.core.trust_fallback import load_trust_engine_cls

    return load_trust_engine_cls()[1]
