import numpy as np
import pytest
from hearsay.calibration import (
    auc_high,
    fit_calibration,
    fit_logistic,
    leave_one_out_scores,
    operating_threshold,
)


def vectors(count, *, axis, dimensions=192, jitter=0.01):
    result = []
    for index in range(count):
        row = np.zeros(dimensions)
        row[axis] = 1
        row[2 + index % (dimensions - 2)] = jitter
        result.append(row)
    return result


def arguments():
    return {
        "model": "detector",
        "revision": "a" * 40,
        "speaker_revision": "b" * 40,
        "real_margins": np.linspace(-3, -1, 20),
        "synthetic_margins": np.linspace(1, 3, 20),
        "owner_embeddings": vectors(20, axis=0),
        "impostor_embeddings": vectors(10, axis=1),
        "synthetic_embeddings": vectors(20, axis=0, jitter=0.02),
        "owner_spectral": vectors(20, axis=0, dimensions=83),
        "impostor_spectral": vectors(10, axis=1, dimensions=83),
        "synthetic_spectral": vectors(20, axis=0, dimensions=83, jitter=0.02),
    }


def test_fits_revision_bound_three_corpus_calibration():
    result = fit_calibration(**arguments())
    assert result["revision"] == "a" * 40
    assert result["speaker_revision"] == "b" * 40
    assert result["cm_scale"] > 0
    assert 0 < result["thresholds"]["cm"] < 1
    assert -1 <= result["thresholds"]["asv_low"] < result["thresholds"]["asv_high"] <= 1
    assert -1 <= result["thresholds"]["spectral"] <= 1
    assert result["evidence"]["counts"] == {
        "owner": 20,
        "human_impostor": 10,
        "synthetic_clone": 20,
    }


def test_logistic_calibration_is_positive_and_data_driven():
    scale, bias = fit_logistic([-3, -2] * 10, [2, 3] * 10)
    assert scale > 0
    assert 1 / (1 + np.exp(-(scale * -2 + bias))) < 0.5
    assert 1 / (1 + np.exp(-(scale * 2 + bias))) > 0.5


def test_operating_helpers_and_leave_one_out():
    point = operating_threshold([0.8, 0.9], [0.1, 0.2])
    assert point["balanced_error"] == 0
    assert 0.2 < point["threshold"] < 0.8
    assert auc_high([2], [1]) == 1
    assert np.all(leave_one_out_scores(vectors(3, axis=0)) > 0.99)


def test_rejects_missing_human_impostors_and_reversed_cm():
    missing = arguments()
    missing["impostor_embeddings"] = missing["impostor_embeddings"][:9]
    with pytest.raises(ValueError, match="at least 10"):
        fit_calibration(**missing)
    reversed_scores = arguments()
    reversed_scores["real_margins"], reversed_scores["synthetic_margins"] = (
        reversed_scores["synthetic_margins"],
        reversed_scores["real_margins"],
    )
    with pytest.raises(ValueError, match="synthetic-high"):
        fit_calibration(**reversed_scores)
    weak = arguments()
    weak["real_margins"] = [-1] * 15 + [1] * 5
    weak["synthetic_margins"] = [1] * 15 + [-1] * 5
    with pytest.raises(ValueError, match="production gate"):
        fit_calibration(**weak)


def test_rejects_unpinned_revisions_and_unusable_speaker_direction():
    unpinned = arguments()
    unpinned["revision"] = "main"
    with pytest.raises(ValueError, match="full Hugging Face commit SHA"):
        fit_calibration(**unpinned)
    reversed_speakers = arguments()
    reversed_speakers["impostor_embeddings"] = reversed_speakers["owner_embeddings"][:10]
    with pytest.raises(ValueError, match="speaker direction"):
        fit_calibration(**reversed_speakers)
