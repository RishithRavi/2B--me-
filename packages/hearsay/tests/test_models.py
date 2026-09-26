import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest
from hearsay.audio import CM_WINDOW
from hearsay.models import (
    Countermeasure,
    SpeakerEncoder,
    logits_margin,
    pinned_revision,
    speaker_match,
)

SHA = "a" * 40


def test_detector_direction_and_raw_logit_mean():
    calls = []

    def infer(window):
        calls.append(window[0])
        return [[float(window[0]), -2]]

    detector = Countermeasure(infer, model="fake", revision=SHA, spoof_index=0)
    x = np.arange(4 * CM_WINDOW, dtype=np.float32)
    assert detector.score(x) == pytest.approx(np.mean([0, 96900, 193800]) + 2)
    assert len(calls) == 3
    assert detector.score(x, profile="stepup") == 2
    assert logits_margin([[1, 4]], spoof_index=0) == -3
    assert logits_margin([[1, 4]], spoof_index=1) == 3


@pytest.mark.parametrize("value", [[[np.nan, 1]], [[1, np.inf]], [1, 2, 3], [[1, 2], [3, 4]]])
def test_bad_model_output_aborts(value):
    detector = Countermeasure(lambda _: value, model="fake", revision=SHA, spoof_index=0)
    with pytest.raises(ValueError):
        detector.score(np.ones(16000))


def test_countermeasure_is_serialized():
    active, maximum = 0, 0
    lock = threading.Lock()

    def infer(_):
        nonlocal active, maximum
        with lock:
            active += 1
            maximum = max(active, maximum)
        time.sleep(0.005)
        with lock:
            active -= 1
        return [1, 0]

    detector = Countermeasure(infer, model="fake", revision=SHA, spoof_index=0)
    with ThreadPoolExecutor(max_workers=4) as executor:
        assert list(executor.map(detector.score, [np.ones(16000)] * 8)) == [1] * 8
    assert maximum == 1


def test_model_revision_must_be_immutable():
    assert pinned_revision(SHA) == SHA
    for value in ("main", "v1", "1234", "z" * 40):
        with pytest.raises(ValueError):
            pinned_revision(value)


def test_speaker_embedding_normalization_and_multiple_centroids():
    encoder = SpeakerEncoder(lambda _: np.arange(192).reshape(1, 1, 192))
    embedding = encoder.embed(np.ones(16000))
    assert embedding.shape == (192,)
    assert np.linalg.norm(embedding) == pytest.approx(1)
    assert speaker_match(embedding, [-embedding, embedding]) == pytest.approx(1)
    with pytest.raises(ValueError):
        SpeakerEncoder(lambda _: np.zeros(192)).embed(np.ones(16000))
    with pytest.raises(ValueError):
        SpeakerEncoder(lambda _: np.ones(256)).embed(np.ones(16000))


def test_large_finite_embeddings_do_not_overflow_normalization():
    encoder = SpeakerEncoder(lambda _: np.full(192, 1e30, dtype=np.float32))
    embedding = encoder.embed(np.ones(16000))
    assert np.linalg.norm(embedding) == pytest.approx(1)
