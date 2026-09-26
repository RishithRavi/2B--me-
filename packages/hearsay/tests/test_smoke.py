from pathlib import Path

import numpy as np
import pytest
from hearsay.models import Countermeasure, SpeakerEncoder
from hearsay.smoke import measure, summarize_ms
from hearsay.vad import VoiceActivityDetector


def test_smoke_harness_with_fake_models_has_explicit_scope():
    cm = Countermeasure(
        lambda x: [float(x.mean()), 0], model="test", revision="a" * 40, spoof_index=0
    )
    speaker = SpeakerEncoder(lambda _: np.ones(192))
    vad = VoiceActivityDetector(lambda x: [{"start": 0, "end": len(x)}] if x.any() else [])
    real = [Path(f"/real/{i}.wav") for i in range(20)]
    synth = [Path(f"/synth/{i}.wav") for i in range(20)]
    result = measure(
        real,
        synth,
        cm=cm,
        speaker=speaker,
        vad=vad,
        decode=lambda p: np.full(16000, -0.1 if "real" in str(p) else 0.1, dtype="float32"),
    )
    assert result["passed"] and result["silence_passed"]
    assert result["stage_ms"]["cm_stepup"]["n"] == 40
    assert "excludes" in result["timing_scope"]


def test_invalid_smoke_timings_rejected():
    for values in ([], [-1], [float("nan")]):
        with pytest.raises(ValueError):
            summarize_ms(values)
    assert summarize_ms([1, 2, 3])["median"] == 2
