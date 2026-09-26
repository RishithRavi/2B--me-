"""Silero VAD and deterministic segment preparation for step-up inference."""

from collections.abc import Callable
from threading import Lock

import numpy as np

from .audio import SAMPLE_RATE, mono_16k


def speech_segments(samples: np.ndarray, spans: list[dict]) -> dict:
    """Internal result: raw speech duration, close-talker onset and padded PCM.

    Overlapping padding is merged so samples cannot be counted twice. Onset is
    the first segment within 10 dB of the loudest segment's mean-square energy.
    Silence returns no onset and empty speech, leaving RETRY to the service.
    """
    x = mono_16k(samples, SAMPLE_RATE)
    merged = []
    for item in sorted(spans, key=lambda span: span["start"]):
        start, end = item["start"], item["end"]
        if not isinstance(start, int) or not isinstance(end, int) or not 0 <= start < end <= len(x):
            raise ValueError("VAD spans must be valid integer sample offsets")
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    if not merged:
        return {"speech_s": 0.0, "onset_ms": None, "samples": np.empty(0, dtype=np.float32)}
    energy = [float(np.mean(x[a:b].astype(np.float64) ** 2)) for a, b in merged]
    loudest = max(energy)
    if loudest <= 1e-12:
        return {"speech_s": 0.0, "onset_ms": None, "samples": np.empty(0, dtype=np.float32)}
    onset = next(a for (a, _), power in zip(merged, energy, strict=True) if power >= loudest / 10)
    padded = []
    pad = int(0.15 * SAMPLE_RATE)
    for a, b in merged:
        a, b = max(0, a - pad), min(len(x), b + pad)
        if padded and a <= padded[-1][1]:
            padded[-1] = (padded[-1][0], max(b, padded[-1][1]))
        else:
            padded.append((a, b))
    return {
        "speech_s": sum(b - a for a, b in merged) / SAMPLE_RATE,
        "onset_ms": round(onset * 1000 / SAMPLE_RATE),
        "samples": np.concatenate([x[a:b] for a, b in padded]),
    }


class VoiceActivityDetector:
    def __init__(self, timestamps: Callable):
        self._timestamps = timestamps
        self._lock = Lock()

    def analyze(self, samples: np.ndarray) -> dict:
        x = mono_16k(samples, SAMPLE_RATE)
        with self._lock:
            spans = self._timestamps(x)
        return speech_segments(x, spans)

    @classmethod
    def load(cls):
        import torch
        from silero_vad import get_speech_timestamps, load_silero_vad

        model = load_silero_vad()

        def timestamps(x):
            with torch.inference_mode():
                return get_speech_timestamps(
                    torch.from_numpy(x),
                    model,
                    sampling_rate=SAMPLE_RATE,
                    return_seconds=False,
                    speech_pad_ms=0,
                )

        return cls(timestamps)
