#!/usr/bin/env python3
"""Offline pipeline smoke test using generated SYNTHETIC data only."""

from pathlib import Path
import sys, json

root = Path(__file__).resolve().parents[1]
for p in ["packages/common", "packages/features", "packages/ml", "agent", "scripts"]:
    sys.path.insert(0, str(root / p))
from sig_test_contracts import install, spec

install()
from sig_make_fixtures import events
from twobme_ml.cli import from_logs
from twobme_ml.model import UserModel
from twobme_ml.evaluation import evaluate

out = root / "work/synthetic-smoke"
out.mkdir(parents=True, exist_ok=True)
paths = []
for actor in ["a", "b"]:
    path = out / f"{actor}.jsonl"
    path.write_text("".join(json.dumps(e) + "\n" for e in events(actor, minutes=50)))
    paths.append(path)
df = from_logs(paths, spec())
cfg = {"spec": spec()}
model = UserModel.train(df, cfg)
model.save(out / "model")
report = evaluate(df, cfg)
(out / "eval.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
print(
    json.dumps(
        {
            "synthetic_only": True,
            "rows": len(df),
            "enabled_modalities": list(model.models),
            "report_modalities": list(report["modalities"]),
            "live_trials": len(report["live_trials"]),
            "output": str(out),
        },
        indent=2,
    )
)
