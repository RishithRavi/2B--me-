"""Real and explicitly demo-only stub endpoints using shared voice contracts."""

from __future__ import annotations

import asyncio
import time
import uuid
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, File, Form, Header, HTTPException, Response, UploadFile
from twobme_common.types import (
    ChallengeCreateIn,
    ChallengeOut,
    ChallengeResponseOut,
    NextPhrase,
    OkOut,
    TotpEnrollOut,
    TotpVerifyIn,
    TotpVerifyOut,
    VoiceEnrollOut,
    VoiceEnrollStartOut,
    utcnow,
)

from app.auth import CurrentPrincipal
from app.core import events
from app.core.runtime import rt
from app.db import repo_voice
from app.voice import stub
from app.voice.issuer import TTL_S, fresh_material, to_out
from app.voice.state import state


@asynccontextmanager
async def lifespan(app):
    try:
        yield
    finally:
        current = rt().extras.get("voice_service")
        if current:
            current.ready = False
            current.enrollments.clear()
            current.prompt_ids.clear()
            if current.pipeline:
                await asyncio.to_thread(current.pipeline.close)
                current.pipeline = None


router = APIRouter(prefix="/voice", tags=["voice"], lifespan=lifespan)
CLOSED = {"verified", "blocked_spoof", "blocked_impostor", "expired", "cancelled"}


async def checked(challenge_id, principal, *, open_only=False):
    state()
    row = await stub._row_or_404(challenge_id)
    stub._check_subject(principal, row)
    if open_only:
        if row["status"] in CLOSED:
            raise HTTPException(409, "Challenge is closed")
        if row.get("expires_at") and row["expires_at"] <= utcnow():
            await rt().issuer.expire(challenge_id)
            raise HTTPException(410, "Challenge expired")
    return row


@router.post("/enroll/start", response_model=VoiceEnrollStartOut)
async def enroll_start(p: CurrentPrincipal):
    current = state()
    if current.mode == "stub":
        return await stub.enroll_start(p)
    from hearsay.phrases import new_phrase

    now = time.monotonic()
    current.enrollments = {k: v for k, v in current.enrollments.items() if v["until"] > now}
    # Starting over consumes any abandoned enrollment for this subject.
    current.enrollments = {k: v for k, v in current.enrollments.items() if v["user"] != p.user.id}
    if len(current.enrollments) >= 100:
        raise HTTPException(429, "Too many pending enrollments")
    identifier, phrases = uuid.uuid4(), [new_phrase() for _ in range(5)]
    current.enrollments[identifier] = {
        "user": p.user.id,
        "sid": p.sid,
        "phrases": phrases,
        "until": now + 600,
    }
    return VoiceEnrollStartOut(enroll_id=identifier, phrases=phrases)


@router.post("/enroll", response_model=VoiceEnrollOut)
async def enroll(
    p: CurrentPrincipal,
    enroll_id: Annotated[UUID, Form()],
    wav: Annotated[list[UploadFile], File()],
):
    samples = []
    try:
        current = state()
        if current.mode == "stub":
            return await stub.enroll(p, str(enroll_id), wav)
        from app.voice.uploads import read_upload

        ticket = current.enrollments.get(enroll_id)
        if not ticket or ticket["user"] != p.user.id or ticket["sid"] != p.sid:
            raise HTTPException(403, "Invalid enrollment session")
        current.enrollments.pop(enroll_id)  # single-use, including failed/oversized enrollment
        if ticket["until"] <= time.monotonic():
            raise HTTPException(410, "Enrollment expired")
        if len(wav) != 5:
            raise HTTPException(422, "Record exactly five phrases")
        async with current.inference_slots:
            for upload in wav:
                samples.append(await read_upload(upload, current.settings.voice_max_upload_bytes))
            try:
                profile = await current.pipeline.enroll(samples, ticket["phrases"])
            except ValueError as error:
                raise HTTPException(422, str(error)) from None
            await repo_voice.insert_profile(
                user_id=p.user.id, label=current.settings.voice_enrollment_label, **profile
            )
        return VoiceEnrollOut(enrolled=True, n_utts=5, intra_cos=profile["intra_cos"])
    finally:
        samples.clear()
        for upload in wav:
            await upload.close()


@router.post("/challenges", response_model=ChallengeOut)
async def create_challenge(body: ChallengeCreateIn, p: CurrentPrincipal):
    state()
    return await stub.create_challenge(
        body, p
    )  # shared authorization/unlock checks, mode-aware issuer


@router.get("/challenges/{challenge_id}", response_model=ChallengeOut)
async def get_challenge(challenge_id: UUID, p: CurrentPrincipal):
    return to_out(await checked(challenge_id, p))


@router.get("/challenges/{challenge_id}/prompt.mp3")
async def prompt(challenge_id: UUID, p: CurrentPrincipal):
    row = await checked(challenge_id, p, open_only=True)
    current = state()
    if challenge_id in current.busy or row["status"] not in {
        "issued",
        "retry",
        "prompt_ready",
        "prompt_ended",
    }:
        raise HTTPException(409, "Challenge is not awaiting a response")
    if current.mode == "stub":
        return await stub.prompt(challenge_id, p)
    if current.prompts:
        identifier = current.prompt_ids.get(challenge_id)
        if identifier is None:
            raise HTTPException(503, "Prompt is unavailable; request a new challenge")
        audio, media = current.prompts.audio(identifier), "audio/mpeg"
    else:
        audio, media = stub._beep_wav(), "audio/wav"
    if row.get("prompt_first_get_at") is None:
        now = utcnow()
        deadline = min(row["expires_at"], now + timedelta(seconds=30))
        await repo_voice.update_challenge(
            challenge_id, prompt_first_get_at=now, expires_at=deadline
        )
    return Response(audio, media_type=media, headers={"Cache-Control": "no-store"})


@router.post("/challenges/{challenge_id}/prompt-ended", response_model=OkOut)
async def prompt_ended(challenge_id: UUID, p: CurrentPrincipal):
    row = await checked(challenge_id, p, open_only=True)
    current = state()
    if challenge_id in current.busy or row["status"] not in {
        "issued",
        "retry",
        "prompt_ready",
        "prompt_ended",
    }:
        raise HTTPException(409, "Challenge is not awaiting a response")
    if current.mode == "real" and row.get("prompt_first_get_at") is None:
        now = utcnow()  # explicit Speak now fallback when the GET/play was denied
        await repo_voice.update_challenge(
            challenge_id,
            prompt_first_get_at=now,
            expires_at=min(row["expires_at"], now + timedelta(seconds=30)),
        )
    return await stub.prompt_ended(challenge_id, p)


async def finish_real(challenge_id, row, result, p):
    current = state()
    fresh = await checked(challenge_id, p, open_only=True)
    if (
        fresh["status"] != "scoring"
        or fresh["attempt"] != row["attempt"]
        or fresh["phrase"] != row["phrase"]
    ):
        raise HTTPException(409, "Challenge changed during scoring")
    # Prepare a replacement before side effects. Pool failure cannot reuse an old phrase.
    phrase = await fresh_material(challenge_id) if result.decision == "RETRY" else None
    await checked(challenge_id, p, open_only=True)
    await repo_voice.update_challenge(
        challenge_id,
        status=stub.STATUS[result.decision],
        asv_cos=result.asv_cos,
        cm_p_spoof=result.cm_p_spoof,
        spec_sim=result.spec_sim,
        phrase_wer=result.phrase_wer,
        onset_ms=result.onset_ms,
        voice_confidence=result.voice_confidence,
        decision=result.decision,
        findings=result.findings,
    )
    await events.challenge_status(challenge_id, stub.STATUS[result.decision], row["attempt"])
    outcome = await events.voice_decided(challenge_id, result, web_session_id=p.sid)
    next_phrase = None
    if phrase is not None:
        expiry = utcnow() + timedelta(seconds=TTL_S[row["trigger"]])
        await repo_voice.update_challenge(
            challenge_id,
            attempt=row["attempt"] + 1,
            phrase=phrase,
            prompt_first_get_at=None,
            expires_at=expiry,
        )
        next_phrase = NextPhrase(
            phrase=phrase,
            prompt_url=f"/api/voice/challenges/{challenge_id}/prompt.mp3",
            expires_at=expiry,
            attempt=row["attempt"] + 1,
        )
        await events.challenge_status(challenge_id, "retry", row["attempt"] + 1)
    elif result.decision == "FALLBACK_MFA":
        await repo_voice.update_challenge(challenge_id, expires_at=utcnow() + timedelta(seconds=90))
    else:
        current.prompt_ids.pop(challenge_id, None)
    return ChallengeResponseOut(result=result, outcome=outcome, next=next_phrase)


@router.post("/challenges/{challenge_id}/response", response_model=ChallengeResponseOut)
async def response(
    challenge_id: UUID,
    p: CurrentPrincipal,
    wav: Annotated[UploadFile, File()],
    client_prompt_end_ms: Annotated[int | None, Form()] = None,
    x_fake_decision: Annotated[str | None, Header()] = None,
):
    samples = None
    acquired = False
    current = None
    try:
        row = dict(await checked(challenge_id, p, open_only=True))
        current = state()
        if challenge_id in current.busy:
            raise HTTPException(409, "Challenge is being scored")
        if current.mode == "real":
            if x_fake_decision is not None:
                raise HTTPException(400, "Fake decisions are disabled in real mode")
            if row["status"] != "prompt_ended" or row["attempt"] not in (1, 2, 3):
                raise HTTPException(409, "Challenge is not ready for a response")
            if client_prompt_end_ms is not None and not 0 <= client_prompt_end_ms <= 600000:
                raise HTTPException(422, "Invalid prompt timing")
        current.busy.add(challenge_id)
        acquired = True
        if current.mode == "stub":
            return await stub.response(challenge_id, p, wav, client_prompt_end_ms, x_fake_decision)
        from app.voice.uploads import read_upload

        async with current.inference_slots:
            samples = await read_upload(wav, current.settings.voice_max_upload_bytes)
            await checked(challenge_id, p, open_only=True)
            await repo_voice.update_challenge(challenge_id, status="scoring")
            await events.challenge_status(challenge_id, "scoring", row["attempt"])

            async def stage(name, ok):
                await events.voice_stage(challenge_id, name, ok=ok)

            profiles = await repo_voice.get_profiles(row["user_id"])
            try:
                result = await current.pipeline.verify(
                    samples,
                    phrase=row["phrase"],
                    profiles=profiles,
                    trigger=row["trigger"],
                    attempt=row["attempt"],
                    stage=stage,
                )
            except Exception:
                # Unhandled model/VAD failure terminates this attempt; it cannot be retried with old audio.
                await rt().issuer.cancel(challenge_id, "inference_failed")
                raise HTTPException(
                    503, "Voice analysis is unavailable; request a new challenge"
                ) from None
            await events.voice_stage(challenge_id, "done")
            return await finish_real(challenge_id, row, result, p)
    except HTTPException:
        if acquired and current.mode == "real":
            failed = await repo_voice.get_challenge(challenge_id)
            if failed and failed["status"] == "scoring":
                await rt().issuer.cancel(challenge_id, "response_failed")
        raise
    except Exception:
        if acquired and current.mode == "real":
            failed = await repo_voice.get_challenge(challenge_id)
            if failed and failed["status"] == "scoring":
                await rt().issuer.cancel(challenge_id, "response_failed")
        raise HTTPException(503, "Voice analysis is unavailable; request a new challenge") from None
    except asyncio.CancelledError:
        if acquired:
            await rt().issuer.cancel(challenge_id, "request_cancelled")
        raise
    finally:
        samples = None
        await wav.close()
        if acquired:
            current.busy.discard(challenge_id)


@router.post("/totp/verify", response_model=TotpVerifyOut)
async def totp_verify(body: TotpVerifyIn, p: CurrentPrincipal):
    row = await checked(body.challenge_id, p, open_only=True)
    current = state()
    if body.challenge_id in current.busy:
        raise HTTPException(409, "Challenge is being scored")
    if current.mode == "real" and row["status"] != "fallback_mfa":
        raise HTTPException(409, "Challenge is not awaiting MFA")
    current.busy.add(body.challenge_id)
    try:
        return await stub.totp_verify(body, p)
    finally:
        current.busy.discard(body.challenge_id)


@router.post("/totp/enroll", response_model=TotpEnrollOut)
async def totp_enroll(p: CurrentPrincipal):
    state()
    return await stub.totp_enroll(p)
