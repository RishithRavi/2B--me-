import asyncio

import numpy as np
import pytest
from hearsay.dsp import analyze
from hearsay.vad import speech_segments

PHRASE = "amber river quiet falcon lantern"


def tone():
    return (0.15 * np.sin(np.arange(96000) * 2 * np.pi * 150 / 16000)).astype(np.float32)


class CM:
    def __init__(self):
        self.margin = -8
        self.calls = 0

    def score(self, x, profile="hearsay"):
        self.calls += 1
        return self.margin


class Speaker:
    def embed(self, x):
        return np.ones(192, dtype=np.float32) / np.sqrt(192)


class VAD:
    def analyze(self, x):
        return speech_segments(x, [{"start": 1600, "end": len(x)}] if np.max(abs(x)) > 0 else [])


class STT:
    def __init__(self):
        self.text = PHRASE
        self.texts = []
        self.failed = False
        self.calls = 0

    async def transcribe(self, x):
        self.calls += 1
        if self.failed:
            raise ValueError("provider error contains private data")
        return self.texts.pop(0) if self.texts else self.text

    async def warmup(self):
        pass


def profile():
    dsp = analyze(tone())
    return dict(
        speaker_embedding=Speaker().embed(tone()),
        spectral_summary=dsp["ltas_db"],
        mfcc_mean=dsp["mfcc_mean"],
    )


async def verify(pipeline, **overrides):
    kwargs = dict(phrase=PHRASE, profiles=[profile()], trigger="sandbox", attempt=1)
    kwargs.update(overrides)
    return await pipeline.verify(tone(), **kwargs)


@pytest.mark.asyncio
async def test_real_measurements_and_stage_events(pipeline):
    stages = []

    async def stage(name, ok):
        stages.append((name, ok))

    result = await verify(pipeline, stage=stage)
    assert result.decision == "VERIFY"
    assert result.asv_cos > 0.99 and result.spec_sim > 0.99
    assert result.cm_p_spoof < 0.001
    assert result.onset_ms == 100
    assert len(result.spectrogram.db) == 64 and len(result.spectrogram.db[0]) == 128
    assert {s for s, _ in stages} == {"transcribing", "anti-spoof", "speaker", "spectral"}
    assert all(ok for _, ok in stages)


@pytest.mark.asyncio
async def test_spoof_wins_even_when_stt_fails_and_no_profile(pipeline):
    pipeline.cm.margin = 8
    pipeline.stt.failed = True
    result = await verify(pipeline, profiles=[])
    assert result.decision == "BLOCK_SPOOF"
    assert pipeline.stt.calls == 1 and pipeline.cm.calls == 1
    assert result.spectrogram is not None
    assert "private data" not in result.model_dump_json()


@pytest.mark.asyncio
async def test_missing_evidence_never_verifies(pipeline):
    assert (await verify(pipeline, profiles=[])).decision == "FALLBACK_MFA"
    old = profile()
    old.pop("mfcc_mean")
    assert (await verify(pipeline, profiles=[old])).decision == "FALLBACK_MFA"
    pipeline.stt.failed = True
    assert (await verify(pipeline)).decision == "FALLBACK_MFA"


@pytest.mark.asyncio
async def test_silence_retries_then_mfa_without_cm(pipeline):
    for attempt in (1, 3):
        result = await pipeline.verify(
            np.zeros(96000, dtype=np.float32),
            phrase=PHRASE,
            profiles=[profile()],
            trigger="unlock",
            attempt=attempt,
        )
        assert result.decision == ("RETRY" if attempt == 1 else "FALLBACK_MFA")
    assert pipeline.cm.calls == 0


@pytest.mark.asyncio
async def test_enrollment_measures_vectors_and_rejects_spoof(pipeline):
    output = await pipeline.enroll([tone()] * 5, [PHRASE] * 5)
    assert output["n_utts"] == 5 and output["intra_cos"] > 0.99
    assert output["speaker_embedding"].shape == (192,)
    assert output["spectral_summary"].shape == (64,) and output["mfcc_mean"].shape == (20,)
    pipeline.cm.margin = 8
    with pytest.raises(ValueError, match="authenticity"):
        await pipeline.enroll([tone()] * 5, [PHRASE] * 5)


@pytest.mark.asyncio
async def test_cm_calls_are_serialized(pipeline):
    import threading
    import time

    active = 0
    maximum = 0
    lock = threading.Lock()

    def score(x, profile="stepup"):
        nonlocal active, maximum
        with lock:
            active += 1
            maximum = max(maximum, active)
        time.sleep(0.01)
        with lock:
            active -= 1
        return -8

    pipeline.cm.score = score
    await asyncio.gather(*(verify(pipeline) for _ in range(3)))
    assert maximum == 1
