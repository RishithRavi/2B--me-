"""Run on the batch box/serving VM, never auto-download weights on the demo Mac."""

import argparse
import json
import platform
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path

from hearsay.models import DF_ARENA, FALLBACK, Countermeasure, SpeakerEncoder
from hearsay.smoke import measure
from hearsay.vad import VoiceActivityDetector


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--real-dir", type=Path, required=True)
    parser.add_argument("--synth-dir", type=Path, required=True)
    parser.add_argument("--cm-revision", required=True)
    parser.add_argument("--ecapa-revision", required=True)
    parser.add_argument("--model", choices=["df-arena", "fallback"], default="df-arena")
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument("--speaker-cache", type=Path, required=True)
    parser.add_argument("-o", "--output", type=Path, required=True)
    args = parser.parse_args()
    extensions = {".wav", ".flac", ".mp3", ".webm", ".ogg"}
    real = sorted(
        p for p in args.real_dir.rglob("*") if p.suffix.lower() in extensions and p.is_file()
    )
    synth = sorted(
        p for p in args.synth_dir.rglob("*") if p.suffix.lower() in extensions and p.is_file()
    )
    if len(real) < 20 or len(synth) < 20:
        parser.error("need at least 20 real and 20 consented ElevenLabs clips before model loading")
    if args.output.resolve() in {p.resolve() for p in [*real, *synth]}:
        parser.error("output must not overwrite corpus audio")
    cm = Countermeasure.load(
        model=DF_ARENA if args.model == "df-arena" else FALLBACK,
        revision=args.cm_revision,
        device=args.device,
        threads=args.threads,
    )
    speaker = SpeakerEncoder.load(
        revision=args.ecapa_revision,
        savedir=str(args.speaker_cache),
        device=args.device,
    )
    vad = VoiceActivityDetector.load()
    result = measure(real[:20], synth[:20], cm=cm, speaker=speaker, vad=vad)
    result.update(
        generated_at=datetime.now(UTC).isoformat(),
        architecture=platform.machine(),
        platform=platform.platform(),
        python=platform.python_version(),
        device=args.device,
        threads=args.threads,
        detector=cm.identity,
        ecapa_revision=args.ecapa_revision,
        versions={
            name: version(name) for name in ("torch", "transformers", "speechbrain", "silero-vad")
        },
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"passed": result["passed"], "stage_ms": result["stage_ms"]}))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
