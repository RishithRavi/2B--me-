"""Download, load and warm the pinned voice models on the Linux runtime host."""

from __future__ import annotations

import argparse
import json
import math
import platform
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path
from time import perf_counter

import numpy as np
from hearsay.models import DF_ARENA, FALLBACK, Countermeasure, SpeakerEncoder
from hearsay.vad import VoiceActivityDetector


def timed(work):
    started = perf_counter()
    value = work()
    return value, round((perf_counter() - started) * 1000)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cm-revision", required=True)
    parser.add_argument("--ecapa-revision", required=True)
    parser.add_argument("--model", choices=["df-arena", "fallback"], default="df-arena")
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument("--speaker-cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine() not in {"x86_64", "AMD64"}:
        parser.error("model preload is restricted to a Linux amd64 runtime host")
    if args.threads < 1:
        parser.error("threads must be positive")

    model = DF_ARENA if args.model == "df-arena" else FALLBACK
    cm, cm_load_ms = timed(
        lambda: Countermeasure.load(
            model=model,
            revision=args.cm_revision,
            device="cpu",
            threads=args.threads,
        )
    )
    speaker, speaker_load_ms = timed(
        lambda: SpeakerEncoder.load(
            revision=args.ecapa_revision,
            savedir=str(args.speaker_cache),
            device="cpu",
        )
    )
    vad, vad_load_ms = timed(VoiceActivityDetector.load)
    samples = np.zeros(64600, dtype=np.float32)
    margin, cm_warm_ms = timed(lambda: cm.score(samples, profile="stepup"))
    embedding, speaker_warm_ms = timed(lambda: speaker.embed(samples))
    activity, vad_warm_ms = timed(lambda: vad.analyze(samples))
    if not math.isfinite(margin) or embedding.shape != (192,):
        raise ValueError("model warm-up returned an invalid result")
    if activity["speech_s"] != 0:
        raise ValueError("Silero classified the silent warm-up as speech")

    result = {
        "generated_at": datetime.now(UTC).isoformat(),
        "platform": platform.platform(),
        "architecture": platform.machine(),
        "python": platform.python_version(),
        "threads": args.threads,
        "detector": cm.identity,
        "ecapa_revision": args.ecapa_revision,
        "load_ms": {"cm": cm_load_ms, "speaker": speaker_load_ms, "vad": vad_load_ms},
        "warm_ms": {"cm": cm_warm_ms, "speaker": speaker_warm_ms, "vad": vad_warm_ms},
        "versions": {
            name: version(name) for name in ("torch", "transformers", "speechbrain", "silero-vad")
        },
        "scope": "model compatibility and warm-up only; no accuracy or service latency claim",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"passed": True, "output": str(args.output)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
