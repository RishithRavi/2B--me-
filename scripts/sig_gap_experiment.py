#!/usr/bin/env python3
"""Explore repeated evidence and an explicitly low-data workflow branch."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
for p in ("packages/ml", "packages/features", "packages/common/src"):
    sys.path.insert(0, str(ROOT / p))

import numpy as np
import pandas as pd
from twobme_common.spec import load_spec
from twobme_ml.evaluation import block_from_row, roc_metrics
from twobme_ml.model import UserModel, eligible, temporal_subset


def window_metrics(frame, seconds=60):
    x = frame.copy()
    x["bucket"] = pd.to_datetime(x.t, utc=True).astype("int64") // (seconds * 10**9)
    grouped = x.groupby(["actor", "session", "bucket"], as_index=False).typicality.mean()
    return roc_metrics(grouped[grouped.actor == "a"].typicality.tolist(),
                       grouped[grouped.actor == "b"].typicality.tolist())


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--run-dir", required=True)
    args = p.parse_args()
    run = Path(args.run_dir)
    spec = load_spec().model_dump()
    df = pd.read_pickle(run / "features.pkl")
    cfg = {
        "spec": spec,
        "experimental_gates": {"workflow": 13},
        "experimental_min_fold_train": {"workflow": 8},
        "allow_experimental_gate_override": True,
    }
    model = UserModel.train(df, cfg)
    model.save(run / "all-signals-experimental")
    loaded = UserModel.load(run / "all-signals-experimental")
    assert list(loaded.models) == list(model.models)
    a = temporal_subset(eligible(df))
    b = temporal_subset(df[(df.actor == "b") & (df.label == "impostor")])
    exploratory = {}
    for modality, fitted in model.models.items():
        ar = a[a.modality == modality].sort_values("time")
        # Fold outputs are appended in original row order by UserModel.train.
        ascores = fitted["oof_typicality"]
        bscores = [model.score_block(block_from_row(row, spec)).typicality
                   for _, row in b[b.modality == modality].iterrows()]
        exploratory[modality] = roc_metrics(ascores, bscores)

    frames = []
    k = pd.read_csv(run / "keyboard-prefix-scores.csv")
    k["modality"] = "keyboard"
    frames.append(k)
    held = pd.read_csv(run / "scores.csv")
    frames.append(held[held.model == "heldout"])
    windowed = {}
    for modality, rows in pd.concat(frames).groupby("modality"):
        windowed[modality] = window_metrics(rows)
    report = {
        "model": "all-signals-experimental",
        "enabled_modalities": list(model.models),
        "experimental": model.experimental,
        "workflow": {
            "a_blocks": int((a.modality == "workflow").sum()),
            "b_blocks": int((b.modality == "workflow").sum()),
            "calibration_folds": 5,
            "minimum_fold_training_blocks": 8,
            "production_gate_unchanged": 20,
            "artifact_reload": "passed",
        },
        "windowed_60s": windowed,
        "oof_exploratory": exploratory,
        "limitations": [
            "Window metrics contain very few independent windows and are development evidence only.",
            "OOF A scores versus B scores are exploratory: A uses fold models while B uses the full-A model.",
            "B influenced analysis; use a new B recording for final validation.",
            "Workflow has only 13 A and 5 B blocks. It is trained, but cannot support a reliable performance claim.",
        ],
    }
    (run / "gap-experiment.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps({
        "enabled": report["enabled_modalities"],
        "windowed": {m: {k: v[k] for k in ("auc", "eer", "n_genuine", "n_impostor")}
                     for m, v in windowed.items()},
        "oof": {m: {k: v[k] for k in ("auc", "eer", "n_genuine", "n_impostor")}
                for m, v in exploratory.items()},
    }, indent=2))


if __name__ == "__main__":
    main()
