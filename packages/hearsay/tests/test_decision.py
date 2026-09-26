import numpy as np
import pytest
from hearsay.decision import Thresholds, decide
from hearsay.vad import VoiceActivityDetector


@pytest.fixture
def attempt():
    # Test values only: never production thresholds.
    return {
        "thresholds": Thresholds(asv_low=0.2, asv_high=0.7, cm=0.8, spectral=0.6),
        "speech_s": 3,
        "cm_p_spoof": 0.1,
        "phrase_ok": True,
        "asv_cos": 0.8,
        "spec_sim": 0.9,
        "onset_ms": 0,
        "attempt": 1,
        "trigger": "step_up",
    }


def test_success_and_spoof_precedence(attempt):
    assert decide(**attempt) == "VERIFY"
    attempt.update(cm_p_spoof=0.8, speech_s=0, phrase_ok=False, asv_cos=None, onset_ms=None)
    assert decide(**attempt) == "BLOCK_SPOOF"


def test_silence_through_vad_returns_retry_then_fallback(attempt):
    vad = VoiceActivityDetector(lambda _: [])
    result = vad.analyze(np.zeros(16000))
    attempt.update(speech_s=result["speech_s"], onset_ms=result["onset_ms"], cm_p_spoof=None)
    assert decide(**attempt) == "RETRY"
    attempt["attempt"] = 3
    assert decide(**attempt) == "FALLBACK_MFA"


def test_replay_phrase_mismatch_precedes_impostor(attempt):
    attempt.update(phrase_ok=False, asv_cos=0.1)
    assert decide(**attempt) == "RETRY"
    attempt["phrase_ok"] = True
    assert decide(**attempt) == "BLOCK_IMPOSTOR"


@pytest.mark.parametrize(
    "updates",
    [
        {"cm_p_spoof": None},
        {"cm_p_spoof": float("nan")},
        {"cm_p_spoof": 1.2},
        {"asv_cos": None},
        {"spec_sim": float("nan")},
        {"spec_sim": None},
    ],
)
def test_missing_or_invalid_evidence_never_verifies(attempt, updates):
    attempt.update(updates)
    assert decide(**attempt) == "FALLBACK_MFA"


@pytest.mark.parametrize("updates", [{"cm_p_spoof": 0.7}, {"asv_cos": 0.5}])
def test_unlock_gray_zone_retries_without_lock_effects(attempt, updates):
    attempt.update(trigger="unlock", **updates)
    assert decide(**attempt) == "RETRY"
    attempt["attempt"] = 3
    assert decide(**attempt) == "FALLBACK_MFA"


@pytest.mark.parametrize("onset", [-1, 6001, None])
def test_onset_bounds(attempt, onset):
    attempt["onset_ms"] = onset
    assert decide(**attempt) == "RETRY"


def test_inclusive_threshold_boundaries(attempt):
    attempt.update(asv_cos=0.7, spec_sim=0.6, onset_ms=6000)
    assert decide(**attempt) == "VERIFY"
    attempt["asv_cos"] = 0.2
    assert decide(**attempt) == "BLOCK_IMPOSTOR"


def test_thresholds_must_be_explicit_and_valid():
    with pytest.raises(ValueError):
        Thresholds(asv_low=0.8, asv_high=0.7, cm=0.8, spectral=0.6)
