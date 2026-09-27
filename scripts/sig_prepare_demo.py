#!/usr/bin/env python3
"""Package an explicitly selected experimental model and its real evaluation evidence."""
import argparse
import copy
import json
import os
from pathlib import Path
import shutil
import sys
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
for p in ("packages/ml", "packages/features", "packages/common/src", "server"):
    sys.path.insert(0, str(ROOT / p))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--run-dir", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--modalities", nargs="+", required=True)
    args = p.parse_args()
    os.umask(0o077)
    run, out = Path(args.run_dir), Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    from twobme_ml.model import ACTIVE_MODALITIES, UserModel
    from twobme_ml.evaluation import block_from_row
    from app.core.models import ModelManager
    from twobme_common.spec import load_spec
    import pandas as pd
    import numpy as np
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import jsonschema

    full = UserModel.load(run / "full-a-candidate")
    candidate = copy.deepcopy(full)
    if not set(args.modalities) <= set(ACTIVE_MODALITIES):
        raise ValueError("Only keyboard, mouse and scroll are active identity modalities")
    if not set(args.modalities) <= set(candidate.models):
        raise ValueError("Cannot enable a modality that did not qualify for training")
    for m in list(candidate.models):
        if m not in args.modalities:
            del candidate.models[m]
            candidate.disabled[m] = "Disabled after development evaluation; see selection.json."
    candidate.version = 1
    candidate.save(run / "demo-model")
    selection = {
        "enabled": list(candidate.models), "disabled": candidate.disabled,
        "status": "experimental; prepared, not activated in a running website",
        "selection_used_b": True, "needs_fresh_final_validation": True,
        "rationale": {
            "keyboard": "Supplementary 100-block-prefix test gives useful separation; retained for fresh validation.",
            "scroll": "Modest held-out separation; retained as supporting evidence.",
            "mouse": "Global holdout AUC 0.549, EER 0.481, weak beta fit; omitted.",
        },
        "rationale_detector": "Workflow and temporal are not active identity signals. Figures above come "
                              "from the detector v1 evaluation; rerun sig_gap_compare.py before packaging v2.",
    }
    (run / "selection.json").write_text(json.dumps(selection, indent=2) + "\n")

    # Exercise the actual core loading path without inventing an authenticated user
    # or connecting a database. This is a local integration test, not activation.
    uid = uuid.UUID("00000000-0000-0000-0000-000000000001")
    root = run / "loader-check"
    dest = root / str(uid) / "v1"
    candidate.save(dest)
    (dest.parent / "active.json").write_text('{"version": 1}\n')
    manager = ModelManager(root, run, None, None)
    manager.load_all()
    assert manager.backend_name == "twobme_ml"
    assert manager.model_info(uid).enabled_modalities == list(candidate.models)
    df = pd.read_parquet(run / "features.parquet")
    row = df[df.modality == args.modalities[0]].iloc[0]
    block = block_from_row(row, load_spec())
    assert manager.scorer(uid).score_block(block).typicality == candidate.score_block(block).typicality
    selection["core_loader_test"] = "passed with real ModelManager; temporary test identity only"
    (run / "selection.json").write_text(json.dumps(selection, indent=2) + "\n")

    report = json.loads((run / "eval.json").read_text())
    prefix = json.loads((run / "keyboard-prefix-eval.json").read_text())
    report["notes"].append("Supplementary keyboard prefix test is separate in keyboard-prefix-eval.json; different split, not included in this fused ROC.")
    jsonschema.validate(report, json.loads((ROOT / "contracts/schemas/eval.schema.json").read_text()))
    (out / "real-eval.json").write_text(json.dumps(report, indent=2) + "\n")
    for name in ("keyboard-prefix-eval.json", "selection.json", "coverage.json", "split.json"):
        shutil.copyfile(run / name, out / name)

    fig, axes = plt.subplots(1, 2, figsize=(11, 4.6), layout="constrained")
    mods = [("Keyboard*", prefix["metrics"]), ("Mouse", report["modalities"]["mouse"]),
            ("Scroll", report["modalities"]["scroll"])]
    for label, metrics in mods:
        roc = np.array(metrics["roc"])
        axes[0].plot(roc[:, 0], roc[:, 1], label=f'{label}: AUC {metrics["auc"]:.2f}')
    axes[0].plot([0, 1], [0, 1], "--", color="gray", linewidth=1)
    axes[0].set(xlabel="B accepted fraction", ylabel="A accepted fraction", title="Held-out A vs. B")
    axes[0].legend(loc="lower right")
    bars = axes[1].bar([m for m, _ in mods], [100 * v["eer"] for _, v in mods], color=["#2d6cdf", "#a2a7b0", "#20a486"])
    axes[1].bar_label(bars, fmt="%.1f%%")
    axes[1].set(ylabel="Equal-error rate (%) — lower is better", ylim=(0, 60), title="Small development samples")
    fig.suptitle("Real recordings: useful keyboard signal, limited validation", fontsize=14)
    fig.supxlabel("*Keyboard: first 100 blocks train + 60s gap. Mouse/scroll: global 70/30 split + 60s purge.", fontsize=9)
    fig.savefig(out / "real-evaluation.png", dpi=180)
    plt.close(fig)

    with zipfile.ZipFile(out / "behavior-models.zip", "w", compression=zipfile.ZIP_DEFLATED) as z:
        folders = ["demo-model", "full-a-candidate", "holdout-model", "keyboard-prefix-model"]
        for folder in folders:
            for path in (run / folder).iterdir():
                z.write(path, path.relative_to(run))
        for name in ("selection.json", "eval.json", "keyboard-prefix-eval.json", "feature_spec.json"):
            z.write(run / name, name)
        if (out / "REAL-MODEL-RESULTS.md").is_file():
            z.write(out / "REAL-MODEL-RESULTS.md", "README.md")
    print(json.dumps(selection, indent=2))


if __name__ == "__main__":
    main()
