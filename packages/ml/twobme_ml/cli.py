import argparse
import asyncio
from bisect import bisect_right
import json
import os
from pathlib import Path
import pandas as pd
import yaml
from twobme_features import features_from_events
from .model import UserModel
from .evaluation import evaluate


def from_logs(paths, spec):
    rows = []
    actor_origins = {}
    for path in paths:
        events = [
            json.loads(line)
            for line in Path(path).read_text().splitlines()
            if line.strip()
        ]
        if len(events) < 2 or events[0].get("ev") != "header":
            raise ValueError(f"Empty or invalid event log: {path}")
        head = events[0]
        changes = [(0, head["label"], head["actor"])] + [
            (e["t_ns"], e["label"], e["actor"]) for e in events if e["ev"] == "label"
        ]
        # A synthetic/common epoch preserves relative elapsed intervals without interpreting monotonic as wall time.
        offset = actor_origins.setdefault(
            head["actor"],
            pd.Timestamp("2026-01-01", tz="UTC").value - events[1]["t_ns"],
        )
        takeover = (
            min(
                [t for t, label, actor in changes if label == "impostor"]
                or [float("inf")]
            )
            if head["actor"] == "a"
            else float("inf")
        )
        for t, blocks, context in features_from_events(events, spec):
            for b in blocks + ([context] if context else []):
                end_ns = int(b.t_end.timestamp() * 1e9)
                idx = bisect_right([c[0] for c in changes], end_ns) - 1
                _, label, actor = changes[idx]
                rows.append(
                    {
                        "time": pd.Timestamp(end_ns + offset, tz="UTC"),
                        "block_start": pd.Timestamp(
                            int(b.t_start.timestamp() * 1e9) + offset, tz="UTC"
                        ),
                        "session_id": str(Path(path).resolve()),
                        "modality": b.modality,
                        "n": b.n,
                        "features": b.features,
                        "extras": {"transitions": b.transitions or {}, "psd": b.psd},
                        "label": label,
                        "actor": actor,
                        "schema_version": head["schema_version"],
                        "mode": "enroll",
                        "baseline_eligible": label == "genuine",
                        "update_candidate": False,
                        "takeover_excluded": end_ns >= takeover,
                        "synthetic": head.get("synthetic", False),
                    }
                )
    if not rows:
        raise ValueError("Logs yielded no feature blocks")
    return pd.DataFrame(rows)


async def from_db(user_id):
    import asyncpg

    conn = await asyncpg.connect(os.environ["TIGER_DATABASE_URL"])
    try:
        rows = await conn.fetch(
            "SELECT time,block_start,session_id,modality,n,features,extras,label,actor,schema_version,mode,baseline_eligible,update_candidate,flags FROM feature_blocks WHERE user_id=$1 ORDER BY time",
            __import__("uuid").UUID(user_id),
        )
        result = []
        for r in rows:
            d = dict(r)
            d["extras"] = (
                json.loads(d["extras"]) if isinstance(d["extras"], str) else d["extras"]
            )
            raw_flags = d.pop("flags")
            flags = (
                json.loads(raw_flags or "{}")
                if isinstance(raw_flags, (str, type(None)))
                else raw_flags
            )
            for k in ("takeover_excluded", "reset_session", "session_kind"):
                d[k] = flags.get(k, True if k != "session_kind" else "ephemeral")
            result.append(d)
        return pd.DataFrame(result)
    finally:
        await conn.close()


def main():
    p = argparse.ArgumentParser(prog="twobme-ml")
    sub = p.add_subparsers(dest="command", required=True)
    for command in ("train", "eval"):
        c = sub.add_parser(command)
        sources = c.add_mutually_exclusive_group(required=True)
        sources.add_argument("--from-logs", nargs="+")
        sources.add_argument("--from-parquet")
        sources.add_argument("--from-db", action="store_true")
        c.add_argument("--user-id")
        c.add_argument("--spec", default="contracts/feature_spec.yaml")
        c.add_argument(
            "--output",
            default="data/models/local" if command == "train" else "reports/eval.json",
        )
        c.add_argument(
            "--live-evidence", help="JSON containing markers and trust ticks"
        )
    args = p.parse_args()
    spec = yaml.safe_load(Path(args.spec).read_text())
    cfg = {"spec": spec, "schema_version": spec.get("schema_version", 1)}
    try:
        if args.from_logs:
            df = from_logs(args.from_logs, spec)
        elif args.from_parquet:
            df = pd.read_parquet(args.from_parquet)
        else:
            if not args.user_id:
                p.error("--from-db requires --user-id")
            df = asyncio.run(from_db(args.user_id))
        if args.command == "train":
            model = UserModel.train(df, cfg)
            model.save(args.output)
            print(
                json.dumps(
                    {
                        "version": model.version,
                        "enabled_modalities": list(model.models),
                        "disabled": model.disabled,
                    }
                )
            )
        else:
            live = (
                json.loads(Path(args.live_evidence).read_text())
                if args.live_evidence
                else {}
            )
            report = evaluate(df, cfg, live.get("markers", []), live.get("ticks", []))
            path = Path(args.output)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
            print(f"Wrote {path}")
    except (ValueError, OSError) as exc:
        p.exit(1, str(exc) + "\n")


if __name__ == "__main__":
    main()
