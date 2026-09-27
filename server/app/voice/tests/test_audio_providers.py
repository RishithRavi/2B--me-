import io
import shutil
import subprocess

import httpx
import numpy as np
import pytest
import soundfile as sf
from app.voice.config import VoiceSettings
from app.voice.prompts import PromptPool
from app.voice.providers import ElevenSpeech
from app.voice.service import Calibration
from app.voice.uploads import decode, read_upload
from fastapi import HTTPException, UploadFile
from hearsay.audio import AudioDecodeError


def encoded(seconds=6, rate=48000):
    output = io.BytesIO()
    sf.write(output, np.zeros(int(seconds * rate)), rate, format="WAV", subtype="PCM_16")
    return output.getvalue()


def test_native_decode_is_bounded():
    assert len(decode(encoded())) == 96000
    with pytest.raises(AudioDecodeError):
        decode(encoded(7))


@pytest.mark.asyncio
async def test_upload_closed_on_every_path():
    for data, limit, code in [(b"", 4, 422), (b"123456", 4, 413), (b"not audio", 100, 422)]:
        file = io.BytesIO(data)
        upload = UploadFile(file)
        with pytest.raises(HTTPException) as error:
            await read_upload(upload, limit)
        assert error.value.status_code == code and file.closed
    file = io.BytesIO(encoded())
    assert len(await read_upload(UploadFile(file), 1000000)) == 96000 and file.closed


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")
def test_actual_webm_decode_in_memory():
    opus = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", "pipe:0", "-c:a", "libopus", "-f", "webm", "pipe:1"],
        input=encoded(),
        capture_output=True,
        check=True,
    ).stdout
    samples = decode(opus)
    assert 95000 < len(samples) <= 97000


@pytest.mark.asyncio
async def test_pool_single_use_survives_restart_and_only_tops_up_below_twenty(tmp_path):
    calls = []

    async def synthesize(phrase):
        calls.append(phrase)
        return b"fake generated prompt"

    pool = PromptPool(tmp_path, synthesize)
    await pool.warmup()
    assert len(calls) == 50
    identifiers = [(await pool.claim())[0] for _ in range(31)]
    assert len(calls) == 50
    pool = PromptPool(tmp_path, synthesize)
    fresh, _ = await pool.claim()
    assert fresh not in identifiers and len(calls) == 81
    assert pool.audio(fresh) == b"fake generated prompt"
    assert not list(tmp_path.glob("*.tmp"))


def test_stub_cannot_start_in_production():
    with pytest.raises(ValueError):
        VoiceSettings(voice_mode="stub", _env_file=None).mode(demo=False)
    assert VoiceSettings(voice_mode=None, _env_file=None).mode(demo=False) == "real"


def test_calibration_is_bound_to_model(tmp_path):
    import json

    path = tmp_path / "calibration.json"
    path.write_text(
        json.dumps(
            {
                "model": "detector",
                "revision": "a" * 40,
                "thresholds": {"asv_low": 0.35, "asv_high": 0.6, "cm": 0.5, "spectral": 0.8},
                "cm_scale": 1,
                "cm_bias": 0,
                "enrollment_min_speech_s": 8,
                "enrollment_min_cos": 0.55,
            }
        )
    )
    with pytest.raises(ValueError, match="match"):
        Calibration.load(path, model="detector", revision="b" * 40)
    calibration = Calibration.load(path, model="detector", revision="a" * 40)
    assert calibration.probability(0) == 0.5
    assert calibration.probability(-1) < calibration.probability(1)
    assert calibration.enrollment_min_speech_s == 8
    assert calibration.enrollment_min_cos == 0.55


@pytest.mark.asyncio
async def test_scribe_has_no_phrase_context_or_keyterms(monkeypatch):
    actual = httpx.AsyncClient
    seen = []

    def handle(request):
        body = request.content
        assert b"keyterms" not in body and b"initial_prompt" not in body
        assert b"scribe_v2" in body and b"response.wav" in body
        seen.append(request.url.path)
        return httpx.Response(200, json={"text": "words supplied by provider"})

    transport = httpx.MockTransport(handle)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: actual(transport=transport, **kw))
    provider = ElevenSpeech("fake-test-key")
    assert await provider.transcribe(np.zeros(16000)) == "words supplied by provider"
    assert seen == ["/v1/speech-to-text"]


def test_stub_imports_do_not_require_optional_voice_packages():
    import sys

    script = """
import importlib.abc
import sys
class Block(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name.split('.')[0] in {'hearsay', 'soundfile', 'torch', 'silero_vad', 'speechbrain'}:
            raise ImportError('optional dependency intentionally unavailable')
sys.meta_path.insert(0, Block())
from app.voice import router, startup, score_audio
assert router.prefix == '/voice'
"""
    subprocess.run([sys.executable, "-c", script], check=True, capture_output=True)
