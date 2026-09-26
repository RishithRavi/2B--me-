import json

import numpy as np
import pytest
from hearsay.dsp import analyze, findings, spectral_similarity


def tone(hz, seconds=1):
    return (0.1 * np.sin(2 * np.pi * hz * np.arange(int(16000 * seconds)) / 16000)).astype(
        "float32"
    )


def test_fft_frequency_pitch_and_output_shapes():
    result = analyze(tone(200))
    assert result["dsp"]["spectral_centroid_hz"] == pytest.approx(200, abs=4)
    assert result["dsp"]["f0_median_hz"] == pytest.approx(200, abs=3)
    assert len(result["ltas_db"]) == 64
    assert len(result["mfcc_mean"]) == len(result["mfcc_std"]) == 20
    assert np.shape(result["spectrogram"]["db"]) == (64, 128)
    assert len(result["spectrogram"]["t_s"]) == 128
    json.dumps(result, allow_nan=False)


def test_high_frequency_guard_and_ratio():
    low, high = analyze(tone(1000)), analyze(tone(5000))
    assert low["dsp"]["hf_energy_ratio"] < 0.001
    assert high["dsp"]["hf_energy_ratio"] > 0.999
    assert analyze(tone(7600))["dsp"]["spectral_centroid_hz"] <= 7200


@pytest.mark.parametrize("x", [np.zeros(16000), np.zeros(1)])
def test_silence_is_finite_without_false_pitch(x):
    result = analyze(x)
    assert result["dsp"]["f0_median_hz"] == 0
    assert result["dsp"]["spectral_centroid_hz"] == 0
    json.dumps(result, allow_nan=False)


def test_spectral_comparison_cannot_silently_truncate_dimensions():
    result = analyze(tone(200))
    assert spectral_similarity(result["ltas_db"], result["ltas_db"]) == pytest.approx(1)
    with pytest.raises(ValueError):
        spectral_similarity(result["ltas_db"] + result["mfcc_mean"], result["ltas_db"])
    assert "-10.0 dB" in findings({"hf_energy_ratio": 0.01}, {"hf_energy_ratio": 0.1})[0]
