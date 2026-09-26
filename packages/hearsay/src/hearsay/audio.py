"""Audio decoding stays in memory. Callers own and delete uploaded source files."""

import subprocess
from io import BytesIO
from pathlib import Path

import numpy as np
import soundfile as sf
import soxr

SAMPLE_RATE = 16_000
CM_WINDOW = 64_600


class AudioDecodeError(ValueError):
    """Invalid, empty, unsupported or oversized audio."""


def mono_16k(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    x = np.asarray(samples, dtype=np.float32)
    if sample_rate <= 0 or x.ndim not in (1, 2) or x.size == 0:
        raise AudioDecodeError("expected nonempty audio and a positive sample rate")
    if not np.isfinite(x).all():
        raise AudioDecodeError("audio contains nonfinite samples")
    if x.ndim == 2:
        x = x.mean(axis=1)
    if sample_rate != SAMPLE_RATE:
        x = soxr.resample(x, sample_rate, SAMPLE_RATE, quality="HQ")
    return np.ascontiguousarray(x, dtype=np.float32)


def read_audio(path: str | Path, *, max_seconds: float = 120) -> np.ndarray:
    """Decode bounded audio with soundfile, then ffmpeg for webm/opus containers.

    The ffmpeg pipe contains only decoded PCM. No challenge audio is copied to
    disk. Decoder diagnostics are deliberately excluded from exceptions/logs.
    """
    if not np.isfinite(max_seconds) or max_seconds <= 0:
        raise ValueError("max_seconds must be finite and positive")
    source = Path(path)
    try:
        with sf.SoundFile(source) as stream:
            if stream.frames / stream.samplerate > max_seconds:
                raise AudioDecodeError("audio exceeds duration limit")
            return mono_16k(stream.read(dtype="float32", always_2d=True), stream.samplerate)
    except (sf.LibsndfileError, OSError):
        pass
    try:
        decoded = subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-i",
                str(source.resolve()),
                "-map",
                "0:a:0",
                "-vn",
                "-t",
                str(max_seconds + 1),
                "-ac",
                "1",
                "-c:a",
                "pcm_f32le",
                "-f",
                "wav",
                "pipe:1",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=max(15, max_seconds * 2),
        ).stdout
    except (OSError, subprocess.SubprocessError) as exc:
        raise AudioDecodeError("unable to decode audio") from exc
    try:
        x, native_rate = sf.read(BytesIO(decoded), dtype="float32")
    except (sf.LibsndfileError, ValueError) as exc:
        raise AudioDecodeError("unable to decode audio") from exc
    if len(x) > max_seconds * native_rate:
        raise AudioDecodeError("audio exceeds duration limit")
    return mono_16k(x, native_rate)


def cm_windows(samples: np.ndarray, *, max_windows: int) -> list[np.ndarray]:
    """One onset window for step-up; up to three spaced windows for Hearsay."""
    x = np.asarray(samples, dtype=np.float32)
    if x.ndim != 1 or not x.size or not np.isfinite(x).all():
        raise AudioDecodeError("CM needs finite, nonempty mono audio")
    if max_windows not in (1, 3):
        raise ValueError("max_windows must be 1 (stepup) or 3 (hearsay)")
    if len(x) < CM_WINDOW:
        return [np.tile(x, int(np.ceil(CM_WINDOW / len(x))))[:CM_WINDOW]]
    count = min(max_windows, int(np.ceil(len(x) / CM_WINDOW)))
    # For a single step-up window onset takes precedence over right alignment.
    starts = np.linspace(0, len(x) - CM_WINDOW, count, dtype=int)
    return [x[start : start + CM_WINDOW] for start in starts]
