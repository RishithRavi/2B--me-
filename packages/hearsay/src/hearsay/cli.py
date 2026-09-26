"""Offline tools; real inference and official submission require the batch box."""

import argparse
import json
import sys
from importlib.resources import files
from pathlib import Path

from .metrics import Costs, direction_check, eer, min_dcf
from .phrases import new_phrase
from .submission import write_submission


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="hearsay")
    parser.add_argument("--config", type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("phrase", help="draw a new five-word challenge")
    metrics = commands.add_parser("eval", help="evaluate saved synth-high margins")
    metrics.add_argument("scores", type=Path, help='JSON: {"real": [...], "synth": [...]}')
    smoke = commands.add_parser("direction-check", help="20 real + 20 clone direction smoke")
    smoke.add_argument("scores", type=Path)
    writer = commands.add_parser("write-tsv", help="write scores into the official template")
    writer.add_argument("scores", type=Path, help="JSON basename -> margin or null (unreadable)")
    writer.add_argument("--template", type=Path, required=True)
    writer.add_argument("-o", "--output", type=Path, required=True)
    writer.add_argument("--direction", required=True, choices=["synth_high", "bona_high"])
    writer.add_argument("--rank-offset", type=float)
    writer.add_argument("--no-header", action="store_true")
    batch = commands.add_parser("predict", help="resumable model inference (batch box)")
    batch.add_argument("directory", type=Path)
    batch.add_argument("--template", type=Path, required=True)
    batch.add_argument("-o", "--output", type=Path, required=True)
    batch.add_argument("--partial", type=Path, required=True)
    batch.add_argument("--model", choices=["df-arena", "fallback"], default="df-arena")
    batch.add_argument("--revision", required=True, help="full immutable model commit SHA")
    batch.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    batch.add_argument("--threads", type=int, default=4)
    batch.add_argument("--max-seconds", type=float, default=120)
    batch.add_argument("--direction", required=True, choices=["synth_high", "bona_high"])
    batch.add_argument("--rank-offset", type=float)
    batch.add_argument("--no-header", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.command == "phrase":
            print(new_phrase())
            return 0
        scores = None if args.command == "predict" else json.loads(args.scores.read_text())
        if args.command == "direction-check":
            result = direction_check(scores["real"], scores["synth"])
        else:
            import yaml

            config_path = args.config or files("hearsay").joinpath("config.yaml")
            config = yaml.safe_load(config_path.read_text())
            if args.command == "predict":
                from .models import DF_ARENA, FALLBACK, Countermeasure, pinned_revision
                from .predict import predict

                cfg = config["submission"]
                # Delay loading until the first uncached file; a complete journal
                # can be re-rendered without model dependencies or downloads.
                model_name = DF_ARENA if args.model == "df-arena" else FALLBACK
                pinned_revision(args.revision)
                if args.threads < 1:
                    raise ValueError("threads must be positive")
                detector = None

                def score(audio):
                    nonlocal detector
                    if detector is None:
                        detector = Countermeasure.load(
                            model=model_name,
                            revision=args.revision,
                            device=args.device,
                            threads=args.threads,
                        )
                    return detector.score(audio)

                result = predict(
                    args.directory,
                    args.template,
                    args.output,
                    args.partial,
                    score=score,
                    identity={
                        "model": model_name,
                        "revision": args.revision,
                        "spoof_index": 0 if args.model == "df-arena" else 1,
                        "extractor_version": 1,
                        "device": args.device,
                        "threads": args.threads,
                    },
                    direction=args.direction,
                    rank_offset=cfg["rank_offset"]
                    if args.rank_offset is None
                    else args.rank_offset,
                    header=cfg["header"] and not args.no_header,
                    max_seconds=args.max_seconds,
                    score_min=cfg["score_min"],
                    score_max=cfg["score_max"],
                )
                result["rules_confirmed"] = bool(config["rules_confirmed"])
            elif args.command == "eval":
                real, synth = scores["real"], scores["synth"]
                result = {
                    "n": len(real) + len(synth),
                    "eer": eer(real, synth),
                    "rules_confirmed": bool(config["rules_confirmed"]),
                }
                for key in ("a", "b"):
                    result[f"min_dcf_{key}"] = min_dcf(real, synth, Costs(**config["metrics"][key]))
                result["mean_min_dcf"] = (result["min_dcf_a"] + result["min_dcf_b"]) / 2
            else:
                cfg = config["submission"]
                result = write_submission(
                    args.template,
                    args.output,
                    scores,
                    direction=args.direction,
                    rank_offset=cfg["rank_offset"]
                    if args.rank_offset is None
                    else args.rank_offset,
                    header=cfg["header"] and not args.no_header,
                    score_min=cfg["score_min"],
                    score_max=cfg["score_max"],
                )
                result["rules_confirmed"] = bool(config["rules_confirmed"])
        print(json.dumps(result, sort_keys=True, allow_nan=False))
        return 0
    except (ValueError, KeyError, TypeError, OSError) as exc:
        print(f"hearsay: {exc}", file=sys.stderr)
        return 2
