"""Explicit batch-box smoke test: real models and consented local recordings."""

from collections.abc import Callable
from pathlib import Path
from time import perf_counter

import numpy as np

from .audio import SAMPLE_RATE, read_audio
from .dsp import analyze
from .metrics import direction_check


def summarize_ms(values: list[float]) -> dict:
    if not values or not np.isfinite(values).all() or min(values) < 0:
        raise ValueError("timings must be nonempty, finite and nonnegative")
    return {
        "n": len(values),
        "median": float(np.median(values)),
        "p95": float(np.percentile(values, 95)),
        "max": max(values),
    }


def measure(
    real: list[Path],
    synth: list[Path],
    *,
    cm,
    speaker,
    vad,
    decode: Callable = read_audio,
    warmups: int = 2,
) -> dict:
    """Sequential inference timings are explicitly not end-to-end service latency."""
    if len(real) < 20 or len(synth) < 20 or warmups < 1:
        raise ValueError("need >=20 clips per class and at least one warmup")
    if len({p.resolve() for p in [*real, *synth]}) != len(real) + len(synth):
        raise ValueError("smoke corpora must be disjoint with no duplicate paths")
    silence = vad.analyze(np.zeros(SAMPLE_RATE, dtype=np.float32))
    if silence["speech_s"] != 0 or silence["onset_ms"] is not None:
        raise ValueError("Silero silence smoke failed")
    initial = decode(real[0])
    for _ in range(warmups):
        activity = vad.analyze(initial)
        if activity["speech_s"] < 1:
            raise ValueError("warmup clip needs at least one second of detected speech")
        cm.score(activity["samples"], profile="stepup")
        cm.score(initial, profile="hearsay")
        speaker.embed(activity["samples"])
        analyze(activity["samples"])
    times = {key: [] for key in ("vad", "cm_stepup", "cm_hearsay", "speaker", "dsp")}
    stepup_margins, hearsay_margins = [], []

    def timed(stage, fn, *args, **kwargs):
        start = perf_counter()
        value = fn(*args, **kwargs)
        times[stage].append((perf_counter() - start) * 1000)
        return value

    for path in [*real, *synth]:
        x = decode(path)
        speech = timed("vad", vad.analyze, x)
        if speech["speech_s"] < 1:
            raise ValueError("smoke corpus has a clip with under one second of speech")
        stepup_margins.append(timed("cm_stepup", cm.score, speech["samples"], profile="stepup"))
        hearsay_margins.append(timed("cm_hearsay", cm.score, x, profile="hearsay"))
        timed("speaker", speaker.embed, speech["samples"])
        timed("dsp", analyze, speech["samples"])
    directions = {}
    for name, margins in (("stepup", stepup_margins), ("hearsay", hearsay_margins)):
        try:
            directions[name] = {
                "passed": True,
                **direction_check(margins[: len(real)], margins[len(real) :]),
            }
        except ValueError as exc:
            directions[name] = {"passed": False, "reason": str(exc)}
    return {
        "passed": all(value["passed"] for value in directions.values()),
        "silence_passed": True,
        "warmups": warmups,
        "directions": directions,
        "stage_ms": {name: summarize_ms(values) for name, values in times.items()},
        "timing_scope": "sequential warmed inference; excludes upload, STT, TTS and model load",
    }
