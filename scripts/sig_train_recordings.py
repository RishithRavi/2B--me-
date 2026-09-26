#!/usr/bin/env python3
"""Local, reproducible real-recording training. Never uploads data or activates a server."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
for package in ("packages/common", "packages/features", "packages/ml", "scripts"):
    sys.path.insert(0, str(ROOT / package))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--from-logs", nargs="+", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--spec", default=str(ROOT / "contracts/feature_spec.yaml"))
    p.add_argument("--standalone-pre-cp0", action="store_true",
                   help="Explicitly use isolated test DTO/spec; artifacts need canonical integration validation")
    args = p.parse_args()
    os.umask(0o077)
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=False)
    if args.standalone_pre_cp0:
        from sig_test_contracts import install, spec
        install()
        feature_spec = spec()
    else:
        import yaml
        feature_spec = yaml.safe_load(Path(args.spec).read_text())

    import numpy as np
    import pandas as pd
    from twobme_ml.cli import from_logs
    from twobme_ml.model import UserModel, eligible, temporal_subset
    from twobme_ml.evaluation import evaluate, block_from_row, roc_metrics

    cfg = {"spec": feature_spec, "schema_version": feature_spec.get("schema_version", 1)}
    df = from_logs(args.from_logs, feature_spec)
    if df.synthetic.any():
        raise ValueError("This runner requires real recordings only")
    # Do not propagate usernames or source paths into the extracted artifact.
    sessions = {s: f"session-{i + 1}" for i, s in enumerate(df.session_id.unique())}
    df["session_id"] = df.session_id.map(sessions)
    df.to_pickle(out / "features.pkl")
    # Canonical vector columns are portable to the core's source=logs trainer.
    parquet = df.copy()
    parquet["features"] = [
        [row.features.get(f["name"]) for f in feature_spec["modalities"][row.modality]["features"]]
        for row in df.itertuples()
    ]
    parquet.to_parquet(out / "features.parquet", index=False)

    def write(name, value):
        (out / name).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")

    write("feature_spec.json", feature_spec)
    counts = temporal_subset(df).groupby(["actor", "modality"]).size()
    print("Independent block counts: " + str(counts.to_dict()), flush=True)
    a = df[(df.actor == "a") & (df.label == "genuine")].sort_values("time")
    cut = pd.Timestamp(a.iloc[int(len(a) * .7)].block_start)
    atrain = a[a.time < cut - pd.Timedelta(seconds=60)]
    atest = a[a.block_start >= cut]
    split = {
        "cut_relative_epoch": cut.isoformat(),
        "training_counts": temporal_subset(eligible(atrain)).groupby("modality").size().to_dict(),
        "test_counts": temporal_subset(atest).groupby("modality").size().to_dict(),
        "purge_seconds": 60,
    }
    write("split.json", split)
    print("Training held-out evaluation model", flush=True)
    heldout = UserModel.train(atrain, cfg)
    heldout.save(out / "holdout-model")
    report = evaluate(df, cfg)
    report["notes"].extend([
        "REAL recordings; no synthetic data used. These few sessions are limited development evidence.",
        "Pre-CP0 standalone DTO/spec harness; not integrated or activated." if args.standalone_pre_cp0 else "Canonical feature specification used.",
        "Fused ROC is an offline weighted typicality summary, not the live TrustEngine or checkout accuracy.",
    ])
    report["split"] = split
    write("eval.json", report)
    print("Held-out results: " + json.dumps({m: {k: v[k] for k in ("auc", "eer", "weak")} for m, v in report["modalities"].items()}), flush=True)
    print("Training full-A candidate (B excluded)", flush=True)
    full = UserModel.train(df, cfg)
    full.save(out / "full-a-candidate")
    diagnostics = {}
    score_rows = []
    for model_name, model, rows in [
        ("heldout", heldout, pd.concat([atest, df[df.actor == "b"]])),
        ("full_a_fit_diagnostic", full, df),
    ]:
        grouped = {}
        for _, row in temporal_subset(rows).iterrows():
            s = model.score_block(block_from_row(row, feature_spec))
            if s is None:
                continue
            grouped.setdefault(row.modality, {}).setdefault(row.actor, []).append(s.typicality)
            score_rows.append({"model": model_name, "actor": row.actor, "session": row.session_id,
                               "modality": row.modality, "t": row.time.isoformat(), "typicality": s.typicality})
        diagnostics[model_name] = {
            m: {"metrics": roc_metrics(v.get("a", []), v.get("b", [])),
                "median_typicality": {actor: float(np.median(values)) for actor, values in v.items()}}
            for m, v in grouped.items()
        }
    write("diagnostics.json", {"warning": "Full-A genuine scores reuse training data: fit diagnostics only, never test accuracy.", "results": diagnostics})
    pd.DataFrame(score_rows).to_csv(out / "scores.csv", index=False)
    coverage = {}
    for (actor, modality), rows in temporal_subset(df).groupby(["actor", "modality"]):
        features = pd.DataFrame(rows.features.tolist(), dtype=float)
        coverage[f"{actor}/{modality}"] = {"blocks": len(rows), "missing_fraction": features.isna().mean().to_dict()}
    write("coverage.json", coverage)
    write("manifest.json", {
        "real_data": True, "standalone_pre_cp0": args.standalone_pre_cp0,
        "activated": False, "baseline_actor": "a", "impostor_used_in_training": False,
        "full_a_modalities": list(full.models), "full_a_disabled": full.disabled,
        "heldout_modalities": list(heldout.models), "heldout_disabled": heldout.disabled,
        "live_trials": 0, "source_sha256": [hashlib.sha256(Path(f).read_bytes()).hexdigest() for f in args.from_logs],
    })
    # Verify serialization preserves actual predictions.
    loaded = UserModel.load(out / "full-a-candidate")
    row = df[df.modality.isin(full.models)].iloc[0]
    block = block_from_row(row, feature_spec)
    assert loaded.score_block(block).typicality == full.score_block(block).typicality
    print("Saved artifacts and verified model reload: " + str(out), flush=True)


if __name__ == "__main__":
    main()
