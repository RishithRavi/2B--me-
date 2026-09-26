"""Bounded speech providers. Phrase text is never supplied as STT context/keyterms.

REST contracts: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
and https://elevenlabs.io/docs/api-reference/text-to-speech/convert
"""

import asyncio
import io
import re
from threading import Lock

import httpx
import numpy as np
import soundfile as sf


class LocalSTT:
    def __init__(self, model):
        self.model = model
        self.lock = Lock()

    @classmethod
    def load(cls, path):
        from faster_whisper import WhisperModel

        if path is None or not path.is_dir():
            raise ValueError("VOICE_LOCAL_STT_PATH must point to a preinstalled model directory")
        return cls(
            WhisperModel(
                str(path), device="cpu", compute_type="int8", cpu_threads=2, local_files_only=True
            )
        )

    def _transcribe(self, samples):
        with self.lock:
            segments, _ = self.model.transcribe(
                samples,
                language="en",
                beam_size=1,
                vad_filter=False,
                condition_on_previous_text=False,
            )
            return " ".join(segment.text for segment in segments)[:10000]

    async def transcribe(self, samples):
        return await asyncio.to_thread(self._transcribe, samples)

    async def warmup(self):
        await self.transcribe(np.zeros(16000, dtype=np.float32))


class ElevenSpeech:
    def __init__(self, key: str, voice_id: str = ""):
        if not key:
            raise ValueError("ELEVENLABS_API_KEY is required")
        self.key, self.voice_id = key, voice_id

    async def transcribe(self, samples):
        with io.BytesIO() as wav:
            sf.write(wav, samples, 16000, format="WAV", subtype="PCM_16")
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.post(
                    "https://api.elevenlabs.io/v1/speech-to-text",
                    headers={"xi-api-key": self.key},
                    data={
                        "model_id": "scribe_v2",
                        "language_code": "eng",
                        "tag_audio_events": "false",
                        "diarize": "false",
                    },
                    files={"file": ("response.wav", wav.getvalue(), "audio/wav")},
                )
                response.raise_for_status()
                text = response.json().get("text")
                if not isinstance(text, str) or len(text) > 10000:
                    raise ValueError("invalid transcription response")
                return text

    async def warmup(self):
        # No paid request or audio transmission is needed to validate credentials are present.
        return None

    async def synthesize(self, phrase):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", self.voice_id):
            raise ValueError("ELEVENLABS_PROMPT_VOICE_ID is required")
        async with httpx.AsyncClient(timeout=15) as client:
            async with client.stream(
                "POST",
                f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}",
                params={"output_format": "mp3_44100_128"},
                headers={"xi-api-key": self.key},
                json={"model_id": "eleven_flash_v2_5", "text": phrase},
            ) as response:
                response.raise_for_status()
                audio = bytearray()
                async for part in response.aiter_bytes():
                    audio.extend(part)
                    if len(audio) > 1024 * 1024:
                        raise ValueError("prompt response exceeds size limit")
                if not audio:
                    raise ValueError("empty prompt response")
                return bytes(audio)
