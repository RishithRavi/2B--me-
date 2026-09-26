import numpy as np
import pytest
from hearsay.vad import VoiceActivityDetector, speech_segments


def test_silence_has_no_speech_or_onset():
    vad = VoiceActivityDetector(lambda _: [])
    result = vad.analyze(np.zeros(16000))
    assert result["speech_s"] == 0
    assert result["onset_ms"] is None
    assert result["samples"].size == 0
    result = speech_segments(np.zeros(16000), [{"start": 0, "end": 16000}])
    assert result["speech_s"] == 0


def test_close_talker_onset_ignores_quiet_bystander():
    x = np.zeros(48000, dtype=np.float32)
    x[1600:8000] = 0.01
    x[16000:32000] = 0.5
    result = speech_segments(x, [{"start": 1600, "end": 8000}, {"start": 16000, "end": 32000}])
    assert result["onset_ms"] == 1000
    assert result["speech_s"] == 1.4


def test_overlap_and_padding_do_not_duplicate_samples():
    x = np.ones(16000, dtype=np.float32)
    result = speech_segments(
        x,
        [{"start": 3000, "end": 6000}, {"start": 5000, "end": 7000}, {"start": 8000, "end": 10000}],
    )
    assert result["speech_s"] == 6000 / 16000
    assert len(result["samples"]) == 11800


@pytest.mark.parametrize(
    "span",
    [
        {"start": -1, "end": 5},
        {"start": 5, "end": 2},
        {"start": 0, "end": 16001},
        {"start": 1.2, "end": 5},
    ],
)
def test_invalid_spans_rejected(span):
    with pytest.raises(ValueError):
        speech_segments(np.ones(16000), [span])
