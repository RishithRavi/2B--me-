"""Fit a revision-bound calibration from consented owner, impostor and clone clips."""

import argparse
import json
import platform
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path

import numpy as np
from hearsay.audio import read_audio
from hearsay.calibration import fit_calibration
from hearsay.dsp import analyze, spectral_vector
from hearsay.models import DF_ARENA, FALLBACK, Countermeasure, SpeakerEncoder, pinned_revision
from hearsay.vad import VoiceActivityDetector

EXTENSIONS = {".wav", ".flac", ".mp3", ".m4a", ".webm", ".ogg"}


def corpus(directory: Path) -> list[Path]:
    return sorted(
        path
        for path in directory.rglob("*")
        if path.is_file() and path.suffix.lower() in EXTENSIONS
    )


def collect(paths, *, cm, speaker, vad) -> dict:
    result = {"margins": [], "embeddings": [], "spectral": [], "speech_s": []}
    for path in paths:
        samples = read_audio(path, max_seconds=10)
        activity = vad.analyze(samples)
        if activity["speech_s"] < 1:
            raise ValueError(f"{path.name} has under one second of detected speech")
        speech = activity["samples"]
        dsp = analyze(speech)
        result["margins"].append(cm.score(speech, profile="stepup"))
        result["embeddings"].append(speaker.embed(speech))
        result["spectral"].append(spectral_vector(dsp["ltas_db"], dsp["mfcc_mean"]))
        result["speech_s"].append(activity["speech_s"])
    return result


def enrollment_quality(owner: dict) -> dict:
    speech = np.asarray(owner["speech_s"], dtype=np.float64)
    embeddings = np.asarray(owner["embeddings"], dtype=np.float64)
    embeddings /= np.linalg.norm(embeddings, axis=1)[:, None]
    pairwise = embeddings @ embeddings.T
    pairwise = pairwise[np.triu_indices(len(embeddings), k=1)]
    # Five short challenge phrases yield less speech than five six-second capture windows.
    speech_minimum = float(np.clip(5 * np.percentile(speech, 10) * 0.8, 8, 20))
    cosine_minimum = float(np.clip(np.percentile(pairwise, 5) - 0.03, 0.5, 0.95))
    return {
        "enrollment_min_speech_s": speech_minimum,
        "enrollment_min_cos": cosine_minimum,
        "evidence": {
            "speech_rule": "80% of five times owner speech p10, clipped to 8..20 seconds",
            "owner_speech_p10_s": float(np.percentile(speech, 10)),
            "cosine_rule": "owner pairwise cosine p05 minus 0.03, clipped to 0.5..0.95",
            "owner_pairwise_p05": float(np.percentile(pairwise, 5)),
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner-dir", type=Path, required=True)
    parser.add_argument("--impostor-dir", type=Path, required=True)
    parser.add_argument("--synth-dir", type=Path, required=True)
    parser.add_argument("--cm-revision", required=True)
    parser.add_argument("--ecapa-revision", required=True)
    parser.add_argument("--model", choices=["df-arena", "fallback"], default="df-arena")
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument("--speaker-cache", type=Path, required=True)
    parser.add_argument("-o", "--output", type=Path, required=True)
    args = parser.parse_args()

    pinned_revision(args.cm_revision)
    pinned_revision(args.ecapa_revision)
    owner, impostor, synth = map(corpus, (args.owner_dir, args.impostor_dir, args.synth_dir))
    if len(owner) < 20 or len(impostor) < 10 or len(synth) < 20:
        parser.error("need at least 20 owner, 10 human-impostor and 20 synthetic-clone clips")
    all_paths = [*owner, *impostor, *synth]
    if len({path.resolve() for path in all_paths}) != len(all_paths):
        parser.error("calibration corpora must be disjoint with no duplicate paths")
    if args.output.resolve() in {path.resolve() for path in all_paths}:
        parser.error("output must not overwrite corpus audio")

    model = DF_ARENA if args.model == "df-arena" else FALLBACK
    cm = Countermeasure.load(
        model=model,
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
    measured = {
        "owner": collect(owner, cm=cm, speaker=speaker, vad=vad),
        "impostor": collect(impostor, cm=cm, speaker=speaker, vad=vad),
        "synthetic": collect(synth, cm=cm, speaker=speaker, vad=vad),
    }
    result = fit_calibration(
        model=model,
        revision=args.cm_revision,
        speaker_revision=args.ecapa_revision,
        real_margins=measured["owner"]["margins"],
        synthetic_margins=measured["synthetic"]["margins"],
        owner_embeddings=measured["owner"]["embeddings"],
        impostor_embeddings=measured["impostor"]["embeddings"],
        synthetic_embeddings=measured["synthetic"]["embeddings"],
        owner_spectral=measured["owner"]["spectral"],
        impostor_spectral=measured["impostor"]["spectral"],
        synthetic_spectral=measured["synthetic"]["spectral"],
    )
    quality = enrollment_quality(measured["owner"])
    result.update(
        generated_at=datetime.now(UTC).isoformat(),
        architecture=platform.machine(),
        platform=platform.platform(),
        python=platform.python_version(),
        device=args.device,
        threads=args.threads,
        enrollment_min_speech_s=quality["enrollment_min_speech_s"],
        enrollment_min_cos=quality["enrollment_min_cos"],
        versions={
            name: version(name) for name in ("torch", "transformers", "speechbrain", "silero-vad")
        },
    )
    result["evidence"]["enrollment"] = quality["evidence"]
    result["evidence"]["files"] = {
        "owner": [path.name for path in owner],
        "human_impostor": [path.name for path in impostor],
        "synthetic_clone": [path.name for path in synth],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(
        json.dumps(
            {
                "output": str(args.output),
                "counts": result["evidence"]["counts"],
                "thresholds": result["thresholds"],
            }
        )
    )


if __name__ == "__main__":
    main()
