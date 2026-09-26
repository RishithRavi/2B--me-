#!/usr/bin/env python3
"""Supplementary keyboard holdout: fixed 100-block prefix, never search cutoffs."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
for p in ("packages/ml", "packages/features", "packages/common/src"):
    sys.path.insert(0, str(ROOT / p))

import pandas as pd
from twobme_common.spec import load_spec
from twobme_ml.model import UserModel
from twobme_ml.evaluation import minimum_prefix_split, block_from_row, roc_metrics


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--run-dir", required=True)
    args = p.parse_args()
    out = Path(args.run_dir)
    df = pd.read_parquet(out / "features.parquet")
    spec = load_spec().model_dump()
    train, test = minimum_prefix_split(df, "keyboard")
    model = UserModel.train(train, {"spec": spec})
    b = df[(df.actor == "b") & (df.label == "impostor") & (df.modality == "keyboard")]
    scores = []
    for actor, rows in (("a", test), ("b", b)):
        for _, row in rows.iterrows():
            scores.append({"actor": actor, "session": row.session_id, "t": row.time.isoformat(),
                           "typicality": model.score_block(block_from_row(row, spec)).typicality})
    metric = roc_metrics([r["typicality"] for r in scores if r["actor"] == "a"],
                         [r["typicality"] for r in scores if r["actor"] == "b"])
    report = {"modality": "keyboard", "metrics": metric, "training_blocks": len(train),
              "purge_seconds": 60, "method": "First 100 chronological eligible A keyboard blocks train; future A blocks starting more than 60s after the last training block test. All B keyboard blocks are evaluation-only.",
              "limitations": "Supplementary development split, added after global split exposed insufficient keyboard training count. No cutoff search. Single B session; not an independent final demo test."}
    model.save(out / "keyboard-prefix-model")
    (out / "keyboard-prefix-eval.json").write_text(json.dumps(report, indent=2) + "\n")
    pd.DataFrame(scores).to_csv(out / "keyboard-prefix-scores.csv", index=False)
    print(json.dumps({k: v for k, v in metric.items() if k != "roc"}))


if __name__ == "__main__":
    main()
