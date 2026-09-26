"""STUB (A0) — owner: Codex 2 after CP0. Mounted at /api/voice (§5.3).

The response endpoint returns a canned VoiceResult chosen by the `X-Fake-Decision` header
(VERIFY | RETRY | FALLBACK_MFA | BLOCK_SPOOF | BLOCK_IMPOSTOR; default VERIFY). Everything else
(status transitions, events.voice_decided, TOTP) behaves like the real service so the hub,
/verify and /shop can be built and tested end to end before the real pipeline lands.
"""

from __future__ import annotations

import io
import math
import struct
import time
import uuid
import wave
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, File, Form, Header, HTTPException, Response, UploadFile

from app.auth import CurrentPrincipal, Principal
from app.core import events, totp
from app.core.runtime import rt
from app.db import repo_voice
from app.voice.issuer import FIXED_PHRASE, to_out
from twobme_common.types import (
    ChallengeCreateIn,
    ChallengeOut,
    ChallengeResponseOut,
    NextPhrase,
    OkOut,
    Spectrogram,
    TotpEnrollOut,
    TotpVerifyIn,
    TotpVerifyOut,
    VoiceEnrollOut,
    VoiceEnrollStartOut,
    VoiceResult,
    utcnow,
)

router = APIRouter(prefix="/voice", tags=["voice"])

ENROLL_PHRASES = [
    "amber river quiet falcon lantern", "cobalt meadow silver harbor thistle", "violet canyon gentle ember orchard",
    "crimson willow hollow beacon marble", "golden prairie velvet anchor cedar",
]
STATUS = {"VERIFY": "verified", "BLOCK_SPOOF": "blocked_spoof", "BLOCK_IMPOSTOR": "blocked_impostor",
          "RETRY": "retry", "FALLBACK_MFA": "fallback_mfa"}
CANNED = {
    "VERIFY": dict(voice_confidence=0.91, asv_cos=0.72, cm_p_spoof=0.04, spec_sim=0.88, phrase_wer=0.0, onset_ms=640,
                   findings=["speaker match 0.72 vs enrolled centroid", "spectral envelope within profile"]),
    "BLOCK_SPOOF": dict(voice_confidence=0.31, asv_cos=0.58, cm_p_spoof=0.93, spec_sim=0.61, phrase_wer=0.0,
                        onset_ms=610, findings=["anti-spoof: synthetic speech 0.93", "energy 4–8 kHz −9 dB vs your profile",
                                                "speaker match 0.58 would pass alone"]),
    "BLOCK_IMPOSTOR": dict(voice_confidence=0.22, asv_cos=0.18, cm_p_spoof=0.07, spec_sim=0.55, phrase_wer=0.0,
                           onset_ms=700, findings=["speaker match 0.18 — different speaker"]),
    "RETRY": dict(voice_confidence=0.5, asv_cos=0.5, cm_p_spoof=0.1, spec_sim=0.7, phrase_wer=0.6, onset_ms=900,
                  findings=["phrase check: 2/5 words matched"]),
    "FALLBACK_MFA": dict(voice_confidence=0.55, asv_cos=0.48, cm_p_spoof=0.2, spec_sim=0.7, phrase_wer=0.0,
                         onset_ms=650, findings=["speaker match in gray zone"]),
}


def _spectrogram() -> Spectrogram:
    f = [round(i * 8000 / 63, 1) for i in range(64)]
    t = [round(i * 6.0 / 127, 3) for i in range(128)]
    db = [[round(-80 + 50 * math.exp(-fi / 18) * (0.6 + 0.4 * math.sin(ti / 7 + fi / 11) ** 2), 1)
           for ti in range(128)] for fi in range(64)]
    return Spectrogram(f_hz=f, t_s=t, db=db)


def _canned(decision: str) -> VoiceResult:
    c = CANNED[decision]
    return VoiceResult(decision=decision, dsp={"centroid_hz": 1840.0, "hf_ratio_db": -9.1 if decision == "BLOCK_SPOOF"
                                               else -1.2, "f0_median_hz": 118.0},
                       stage_ms={"stt": 420, "cm": 1100, "asv": 90, "dsp": 60}, spectrogram=_spectrogram(), **c)


async def _row_or_404(challenge_id: UUID) -> dict:
    row = await repo_voice.get_challenge(challenge_id)
    if row is None:
        raise HTTPException(404, "unknown challenge")
    return row


def _check_subject(p: Principal, row: dict) -> None:
    if not p.is_admin and row["user_id"] != p.user.id:
        raise HTTPException(403, "not your challenge")


@router.post("/enroll/start", response_model=VoiceEnrollStartOut)
async def enroll_start(p: CurrentPrincipal) -> VoiceEnrollStartOut:
    return VoiceEnrollStartOut(enroll_id=uuid.uuid4(), phrases=ENROLL_PHRASES)


@router.post("/enroll", response_model=VoiceEnrollOut)
async def enroll(p: CurrentPrincipal, enroll_id: Annotated[str, Form()],
                 wav: Annotated[list[UploadFile], File()]) -> VoiceEnrollOut:
    for f in wav:
        await f.read()  # stub: audio is read and discarded, never stored
    import numpy as np

    rng = np.random.default_rng(abs(hash(p.user.id)) % 2**32)
    emb = rng.normal(size=192)
    emb /= np.linalg.norm(emb)
    await repo_voice.insert_profile(user_id=p.user.id, speaker_embedding=emb, utt_embeddings=[emb.tolist()] * len(wav),
                                    spectral_summary=np.zeros(64), n_utts=len(wav), intra_cos=0.8)
    return VoiceEnrollOut(enrolled=True, n_utts=len(wav), intra_cos=0.8)


@router.post("/challenges", response_model=ChallengeOut)
async def create_challenge(body: ChallengeCreateIn, p: CurrentPrincipal) -> ChallengeOut:
    r = rt()
    dev = r.registry.bound_device(p.user.id)
    if body.reason == "unlock":
        if dev is None or not dev.locked:
            raise HTTPException(409, "device is not locked")
        if not events.can_request_unlock(dev.id, p.session_created_at):
            raise HTTPException(403, "log in again: unlock needs a session created after the lock")
        recent = [c for c in r.repo_voice.challenges.values()
                  if c.get("device_id") == dev.id and c["trigger"] == "unlock"
                  and (utcnow() - c["issued_at"]).total_seconds() < 600]
        if len(recent) >= 3:
            raise HTTPException(429, "too many unlock attempts; wait 10 minutes")
    ch = await r.issuer.issue(device_id=dev.id if dev else None, subject_user_id=p.user.id,
                              session_id=None, trigger=body.reason, decision_id=None)
    await events.challenge_status(ch.challenge_id, ch.status, ch.attempt)
    return ch


@router.get("/challenges/{challenge_id}", response_model=ChallengeOut)
async def get_challenge(challenge_id: UUID, p: CurrentPrincipal) -> ChallengeOut:
    row = await _row_or_404(challenge_id)
    _check_subject(p, row)
    return to_out(row)


def _beep_wav(seconds: float = 1.2, sr: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = b"".join(
            struct.pack("<h", int(8000 * math.sin(2 * math.pi * 880 * i / sr) * (1 if (i // (sr // 5)) % 2 == 0 else 0)))
            for i in range(int(seconds * sr)))
        w.writeframes(frames)
    return buf.getvalue()


@router.get("/challenges/{challenge_id}/prompt.mp3")
async def prompt(challenge_id: UUID, p: CurrentPrincipal) -> Response:
    row = await _row_or_404(challenge_id)
    _check_subject(p, row)
    if row.get("prompt_first_get_at") is None:
        await repo_voice.update_challenge(challenge_id, prompt_first_get_at=utcnow())
    # stub: a beep pattern as WAV (real service: ElevenLabs mp3 from the prompt pool)
    return Response(_beep_wav(), media_type="audio/wav", headers={"Cache-Control": "no-store"})


@router.post("/challenges/{challenge_id}/prompt-ended", response_model=OkOut)
async def prompt_ended(challenge_id: UUID, p: CurrentPrincipal) -> OkOut:
    row = await _row_or_404(challenge_id)
    _check_subject(p, row)
    await repo_voice.update_challenge(challenge_id, status="prompt_ended")
    await events.challenge_status(challenge_id, "prompt_ended", row["attempt"])
    return OkOut()


@router.post("/challenges/{challenge_id}/response", response_model=ChallengeResponseOut)
async def response(
    challenge_id: UUID, p: CurrentPrincipal,
    wav: Annotated[UploadFile, File()],
    client_prompt_end_ms: Annotated[int | None, Form()] = None,
    x_fake_decision: Annotated[str | None, Header()] = None,
) -> ChallengeResponseOut:
    row = await _row_or_404(challenge_id)
    _check_subject(p, row)
    if row["status"] in ("verified", "blocked_spoof", "blocked_impostor", "expired", "cancelled"):
        raise HTTPException(409, f"challenge is {row['status']}")
    await wav.read()  # stub: scored-and-deleted == read and dropped
    decision = (x_fake_decision or "VERIFY").upper()
    if decision not in CANNED:
        raise HTTPException(400, f"X-Fake-Decision must be one of {sorted(CANNED)}")
    attempt = row["attempt"]
    if decision == "RETRY" and attempt >= 3:
        decision = "FALLBACK_MFA"
    await repo_voice.update_challenge(challenge_id, status="scoring")
    await events.challenge_status(challenge_id, "scoring", attempt)
    t0 = time.perf_counter()
    fail_stage = {"BLOCK_SPOOF": "anti-spoof", "BLOCK_IMPOSTOR": "speaker", "RETRY": "transcribing"}.get(decision)
    result = _canned(decision)
    values = {"transcribing": result.phrase_wer, "anti-spoof": result.cm_p_spoof, "speaker": result.asv_cos,
              "spectral": result.spec_sim}
    for stage in ("transcribing", "anti-spoof", "speaker", "spectral"):
        await events.voice_stage(challenge_id, stage, ok=stage != fail_stage, value=values[stage])
    await events.voice_stage(challenge_id, "done")
    result.stage_ms["total"] = int((time.perf_counter() - t0) * 1000)
    status = STATUS[decision]
    await repo_voice.update_challenge(
        challenge_id, status=status, asv_cos=result.asv_cos, cm_p_spoof=result.cm_p_spoof, spec_sim=result.spec_sim,
        phrase_wer=result.phrase_wer, onset_ms=result.onset_ms, voice_confidence=result.voice_confidence,
        decision=decision, findings=result.findings)
    await events.challenge_status(challenge_id, status, attempt)
    outcome = await events.voice_decided(challenge_id, result, web_session_id=p.sid)
    nxt = None
    if decision == "RETRY":
        await repo_voice.update_challenge(challenge_id, attempt=attempt + 1, phrase=FIXED_PHRASE)
        nrow = await repo_voice.get_challenge(challenge_id)
        nxt = NextPhrase(phrase=FIXED_PHRASE, prompt_url=f"/api/voice/challenges/{challenge_id}/prompt.mp3",
                         expires_at=nrow.get("expires_at") if nrow else None, attempt=attempt + 1)
        await events.challenge_status(challenge_id, "retry", attempt + 1)
    return ChallengeResponseOut(result=result, outcome=outcome, next=nxt)


@router.post("/totp/verify", response_model=TotpVerifyOut)
async def totp_verify(body: TotpVerifyIn, p: CurrentPrincipal) -> TotpVerifyOut:
    row = await _row_or_404(body.challenge_id)
    _check_subject(p, row)
    subject = rt().registry.users.get(row["user_id"])
    ok = bool(subject and totp.verify(subject, body.code))
    if ok:
        await repo_voice.update_challenge(body.challenge_id, status="verified", decision="TOTP")
        await events.challenge_status(body.challenge_id, "verified", row["attempt"])
    outcome = await events.totp_decided(body.challenge_id, ok, web_session_id=p.sid)
    return TotpVerifyOut(ok=ok, outcome=outcome)


@router.post("/totp/enroll", response_model=TotpEnrollOut)
async def totp_enroll(p: CurrentPrincipal) -> TotpEnrollOut:
    return TotpEnrollOut(otpauth_uri=totp.enroll(p.user))
