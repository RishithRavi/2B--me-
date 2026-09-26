import shutil
import subprocess

import numpy as np
import pytest
import soundfile as sf
from hearsay.audio import CM_WINDOW, AudioDecodeError, cm_windows, mono_16k, read_audio


def test_native_rate_stereo_wav_resampled_and_not_modified(tmp_path):
    path = tmp_path / "synthetic.wav"
    x = np.sin(2 * np.pi * 440 * np.arange(48000) / 48000).astype("float32") * 0.1
    sf.write(path, np.column_stack([x, x]), 48000, subtype="PCM_16")
    original = path.read_bytes()
    result = read_audio(path)
    assert result.dtype == np.float32
    assert result.shape == (16000,)
    assert np.argmax(abs(np.fft.rfft(result))) == 440
    assert path.read_bytes() == original


def test_resampler_suppresses_out_of_band_signal():
    x = np.sin(2 * np.pi * 12000 * np.arange(48000) / 48000).astype("float32")
    result = mono_16k(x, 48000)
    assert np.sqrt(np.mean(result[100:-100] ** 2)) < 0.001


def test_duration_and_invalid_audio_limits(tmp_path):
    path = tmp_path / "long.wav"
    sf.write(path, np.zeros(32000), 16000)
    with pytest.raises(AudioDecodeError, match="duration"):
        read_audio(path, max_seconds=1)
    for audio in ([], [float("nan")], np.zeros((2, 2, 2))):
        with pytest.raises(AudioDecodeError):
            mono_16k(audio, 16000)


def test_windows_start_at_onset_and_include_tail_for_hearsay():
    x = np.arange(4 * CM_WINDOW, dtype="float32")
    stepup = cm_windows(x, max_windows=1)
    batch = cm_windows(x, max_windows=3)
    assert len(stepup) == 1 and len(batch) == 3
    np.testing.assert_array_equal(stepup[0], x[:CM_WINDOW])
    np.testing.assert_array_equal(batch[-1], x[-CM_WINDOW:])
    assert all(len(window) == CM_WINDOW for window in batch)


def test_short_windows_are_tiled_and_empty_rejected():
    window = cm_windows(np.array([1, 2]), max_windows=3)[0]
    assert window.shape == (CM_WINDOW,)
    np.testing.assert_array_equal(window[:6], [1, 2, 1, 2, 1, 2])
    with pytest.raises(AudioDecodeError):
        cm_windows(np.array([]), max_windows=1)


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg system dependency unavailable")
def test_webm_opus_fallback(tmp_path):
    wav, webm = tmp_path / "synthetic.wav", tmp_path / "synthetic.webm"
    x = np.sin(2 * np.pi * 440 * np.arange(48000) / 48000) * 0.1
    sf.write(wav, x, 48000)
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", str(wav), "-c:a", "libopus", str(webm)],
        check=True,
    )
    result = read_audio(webm)
    assert abs(len(result) - 16000) < 200
    assert result.dtype == np.float32 and np.isfinite(result).all()
    with pytest.raises(AudioDecodeError, match="duration"):
        read_audio(webm, max_seconds=0.5)


def test_corrupt_file_returns_decode_error(tmp_path):
    path = tmp_path / "invalid.wav"
    path.write_bytes(b"not audio")
    with pytest.raises(AudioDecodeError, match="decode"):
        read_audio(path)
