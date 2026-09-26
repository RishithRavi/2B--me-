"""Bounded in-memory decode; always close Starlette's possibly-spooled upload."""

import asyncio
import io
import subprocess

import numpy as np
import soundfile as sf
from fastapi import HTTPException
from hearsay.audio import AudioDecodeError, mono_16k


def decode(payload: bytes):
    try:
        with sf.SoundFile(io.BytesIO(payload)) as audio:
            if not 8000 <= audio.samplerate <= 192000 or not 1 <= audio.channels <= 2:
                raise AudioDecodeError("unsupported sample rate or channel count")
            if not 0 < audio.frames <= audio.samplerate * 6.25:
                raise AudioDecodeError("audio must contain at most 6.25 seconds")
            return mono_16k(audio.read(dtype="float32", always_2d=True), audio.samplerate)
    except sf.LibsndfileError:
        pass
    try:
        # Browser WebM/Opus fallback. Bounded native-rate decode; soxr alone resamples.
        result = subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-protocol_whitelist",
                "pipe",
                "-i",
                "pipe:0",
                "-map",
                "0:a:0",
                "-vn",
                "-t",
                "6.5",
                "-fs",
                "6000000",
                "-ac",
                "1",
                "-c:a",
                "pcm_f32le",
                "-f",
                "wav",
                "pipe:1",
            ],
            input=payload,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=15,
        )
        with sf.SoundFile(io.BytesIO(result.stdout)) as audio:
            if not 8000 <= audio.samplerate <= 192000:
                raise AudioDecodeError("unsupported sample rate")
            samples = audio.read(int(audio.samplerate * 6.5) + 1, dtype="float32", always_2d=True)
            if not 0 < len(samples) <= audio.samplerate * 6.25:
                raise AudioDecodeError("audio must contain at most 6.25 seconds")
            return mono_16k(samples, audio.samplerate)
    except (OSError, subprocess.SubprocessError, sf.LibsndfileError, ValueError) as exc:
        raise AudioDecodeError("unable to decode bounded audio") from exc


async def read_upload(upload, limit: int, *, decode_audio: bool = True):
    try:
        payload = await upload.read(limit + 1)
        if len(payload) > limit:
            raise HTTPException(413, "Audio upload is too large")
        if not payload:
            raise HTTPException(422, "Empty audio upload")
        if not decode_audio:
            return None
        try:
            samples = await asyncio.to_thread(decode, payload)
        except (AudioDecodeError, ValueError):
            raise HTTPException(422, "Invalid or oversized audio") from None
        if not np.isfinite(samples).all():
            raise HTTPException(422, "Nonfinite audio")
        return samples
    finally:
        await upload.close()
