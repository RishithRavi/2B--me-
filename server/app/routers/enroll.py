from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException

from app.auth import AdminPrincipal, CurrentPrincipal, Principal
from app.core.models import TrainingRefused
from app.core.registry import Device
from app.core.runtime import rt
from twobme_common.types import EnrollModeIn, EnrollProgress, EnrollTrainIn, JobOut, ModelInfo, OkOut, RetrainIn

router = APIRouter(tags=["enroll"])


def _device(p: Principal, device_id: UUID) -> Device:
    dev = rt().registry.devices.get(device_id)
    if dev is None or not (p.is_admin or dev.user_id == p.user.id):
        raise HTTPException(404, "unknown device")
    return dev


def _check_can_train(user_id: UUID) -> None:
    r = rt()
    if r.settings.training_frozen:
        raise HTTPException(409, "training is frozen (demo freeze)")
    if r.hub.any_open_challenge(user_id):
        raise HTTPException(409, "a challenge is in flight; resolve it before training")


@router.post("/enroll/mode", response_model=OkOut)
async def enroll_mode(body: EnrollModeIn, p: CurrentPrincipal) -> OkOut:
    dev = _device(p, body.device_id)
    await rt().hub.set_mode(rt().hub.rt(dev), body.mode, source="dashboard")
    return OkOut()


@router.get("/enroll/status", response_model=EnrollProgress)
async def enroll_status(device_id: UUID, p: CurrentPrincipal) -> EnrollProgress:
    dev = _device(p, device_id)
    hub = rt().hub
    drt = hub.rt(dev)
    await hub._ensure_enroll_counts(drt)
    return hub.enroll_progress(drt)


@router.post("/enroll/train", response_model=JobOut)
async def enroll_train(body: EnrollTrainIn, p: CurrentPrincipal) -> JobOut:
    dev = _device(p, body.device_id)
    _check_can_train(dev.user_id)
    try:
        job = rt().models.start_training(dev.user_id, source=body.source, retrain=False)
    except TrainingRefused as e:
        raise HTTPException(409, str(e)) from e
    return JobOut(job_id=job)


@router.post("/models/retrain", response_model=JobOut)
async def retrain(body: RetrainIn, p: CurrentPrincipal) -> JobOut:
    dev = _device(p, body.device_id)
    _check_can_train(dev.user_id)
    try:
        job = rt().models.start_training(dev.user_id, source="tiger", retrain=True)
    except TrainingRefused as e:
        raise HTTPException(409, str(e)) from e
    return JobOut(job_id=job)


def _user(p: Principal, user_id: UUID | None) -> UUID:
    uid = user_id or p.user.id
    if uid != p.user.id and not p.is_admin:
        raise HTTPException(403, "not your model")
    return uid


@router.get("/models/active", response_model=ModelInfo)
async def models_active(p: CurrentPrincipal, user_id: UUID | None = None) -> ModelInfo:
    return rt().models.model_info(_user(p, user_id))


@router.get("/models/history", response_model=list[ModelInfo])
async def models_history(p: CurrentPrincipal, user_id: UUID | None = None) -> list[ModelInfo]:
    return rt().models.versions(_user(p, user_id))


@router.post("/models/activate", response_model=ModelInfo)
async def models_activate(user_id: UUID, version: int, p: AdminPrincipal) -> ModelInfo:
    """Rollback / roll forward to a stored version (admin)."""
    try:
        return await rt().models.activate(user_id, version)
    except FileNotFoundError as e:
        raise HTTPException(404, f"no model v{version}") from e
