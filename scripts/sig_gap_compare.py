#!/usr/bin/env python3
"""Before/after owner-vs-impostor separation (AUC up, EER down) for the v2 detector.

Real recordings (the run directory written by sig_train_recordings.py):
    uv run python scripts/sig_gap_compare.py --run-dir work/my-run
Synthetic development check (seeded pairs from sig_sim_pair.py; never real evidence):
    uv run python scripts/sig_gap_compare.py --synthetic --seeds 8 --similarity 0.35 0.6 1.0

Arms share rows, splits and folds; only the detector differs:
    baseline  detector v1
    v2        detector v2 (new default)
Evaluations:
    heldout   official evaluate() split: chronological 70/30 A with 60s purge; B held out
    oof       full-A model: A's purged out-of-fold typicality vs B scored by that model
    window60  each evaluation's block scores averaged per actor/session per 60s window
Decide from real recordings, never from synthetic pairs, and use a fresh B recording for
any final claim: the existing B session already informed earlier branch choices.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for p in ("packages/ml", "packages/features", "packages/common/src", "scripts"):
    sys.path.insert(0, str(ROOT / p))
for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(var, "1")

import pandas as pd

MODALITIES = ["keyboard", "mouse", "scroll"]
ARMS = {
    "baseline": {"detector": "v1"},
    "v2": {"detector": "v2"},
}


def metrics(genuine, impostor):
    from twobme_ml.evaluation import roc_metrics

    m = roc_metrics(list(genuine), list(impostor))
    return {k: m[k] for k in ("auc", "eer", "n_genuine", "n_impostor")}


def windowed(records, seconds=60):
    if not records:
        return {m: metrics([], []) for m in MODALITIES}
    r = pd.DataFrame(records)
    r["bucket"] = pd.to_datetime(r.t, utc=True).astype("int64") // (seconds * 10**9)
    g = r.groupby(["modality", "actor", "session", "bucket"], as_index=False).typicality.mean()
    return {
        m: metrics(g[(g.modality == m) & (g.actor == "a")].typicality,
                   g[(g.modality == m) & (g.actor == "b")].typicality)
        for m in MODALITIES
    }


def oof_records(df, cfg):
    from twobme_ml.evaluation import block_from_row
    from twobme_ml.model import UserModel, eligible, temporal_subset

    model = UserModel.train(df, cfg)
    a = temporal_subset(eligible(df, cfg.get("now")))
    b = temporal_subset(df[(df.actor == "b") & (df.label == "impostor")])
    records = []
    for m, fitted in model.models.items():
        rows = a[a.modality == m].sort_values("time").reset_index(drop=True)
        # train() appends fold outputs in chronological row order, so indices align.
        for (_, row), t in zip(rows.iterrows(), fitted["oof_typicality"]):
            records.append({"actor": "a", "session": row.session_id, "modality": m,
                            "t": pd.Timestamp(row.time), "typicality": t})
        for _, row in b[b.modality == m].iterrows():
            s = model.score_block(block_from_row(row, cfg["spec"]))
            records.append({"actor": "b", "session": row.session_id, "modality": m,
                            "t": pd.Timestamp(row.time), "typicality": s.typicality})
    return records, model


def by_modality(records):
    r = pd.DataFrame(records) if records else pd.DataFrame(columns=["actor", "modality", "typicality"])
    return {
        m: metrics(r[(r.modality == m) & (r.actor == "a")].typicality,
                   r[(r.modality == m) & (r.actor == "b")].typicality)
        for m in MODALITIES
    }


def compare(df, spec, arms=None):
    from twobme_ml.evaluation import evaluate, heldout_scores

    out = {}
    for arm, extra in (arms or ARMS).items():
        cfg = {"spec": spec, **extra}
        result = {}
        try:
            held = heldout_scores(df, cfg)
            report = evaluate(df, cfg, held=held)
            result["heldout"] = {
                m: {k: report["modalities"][m][k] for k in ("auc", "eer", "n_genuine", "n_impostor")}
                for m in MODALITIES
            }
            result["heldout"]["fused"] = dict(report["fused"])
            result["heldout_window60"] = windowed(held["records"])
            result["heldout_disabled"] = held["a_model"].disabled
        except ValueError as exc:
            result["heldout_error"] = str(exc)
        try:
            records, model = oof_records(df, cfg)
            result["oof"] = by_modality(records)
            result["oof_window60"] = windowed(records)
            result["oof_disabled"] = model.disabled
        except ValueError as exc:
            result["oof_error"] = str(exc)
        out[arm] = result
    return out


def synthetic_job(args):
    seed, similarity, arms = args
    from sig_sim_pair import simulate_pair
    from twobme_common.spec import load_spec
    from twobme_ml.cli import from_logs

    spec = load_spec().model_dump()
    a_logs, b_logs = simulate_pair(seed, similarity)
    with tempfile.TemporaryDirectory() as tmp:
        paths = []
        for name, logs in (("a", a_logs), ("b", b_logs)):
            for i, log in enumerate(logs, 1):
                path = Path(tmp) / f"{name}{i}.jsonl"
                path.write_text("".join(json.dumps(e) + "\n" for e in log))
                paths.append(path)
        df = from_logs(paths, spec)
    return {"seed": seed, "similarity": similarity, "arms": compare(df, spec, arms)}


def table(result, evaluation):
    lines = [f"{evaluation:>16} | " + " | ".join(f"{a:>13}" for a in ARMS) + " | ΔAUC v2−base | ΔEER v2−base"]
    rows = MODALITIES + (["fused"] if evaluation == "heldout" else [])
    for m in rows:
        cells, auc, eer = [], {}, {}
        for arm in ARMS:
            v = result[arm].get(evaluation, {}).get(m) or {}
            auc[arm], eer[arm] = v.get("auc"), v.get("eer")
            cells.append("     disabled" if auc[arm] is None else f"{auc[arm]:.3f}/{eer[arm]:.3f}")
        da = f"{auc['v2'] - auc['baseline']:+.3f}" if None not in (auc["v2"], auc["baseline"]) else "   n/a"
        de = f"{eer['v2'] - eer['baseline']:+.3f}" if None not in (eer["v2"], eer["baseline"]) else "   n/a"
        lines.append(f"{m:>16} | " + " | ".join(f"{c:>13}" for c in cells) + f" | {da:>12} | {de:>12}")
    return "\n".join(lines)


def summarize(jobs, arms=None):
    arms = arms or ARMS
    rows = []
    for job in jobs:
        for arm, res in job["arms"].items():
            for evaluation in ("heldout", "oof", "heldout_window60", "oof_window60"):
                for m, v in (res.get(evaluation) or {}).items():
                    rows.append({"similarity": job["similarity"], "seed": job["seed"], "arm": arm,
                                 "evaluation": evaluation, "modality": m,
                                 "auc": v.get("auc"), "eer": v.get("eer")})
    d = pd.DataFrame(rows)
    wide = d.pivot_table(index=["similarity", "evaluation", "modality", "seed"], columns="arm",
                         values=["auc", "eer"], aggfunc="first")
    summary = []
    for (sim, ev, m), g in wide.groupby(level=[0, 1, 2]):
        entry = {"similarity": sim, "evaluation": ev, "modality": m}
        for arm in arms:
            a = g[("auc", arm)].dropna() if ("auc", arm) in g else pd.Series(dtype=float)
            e = g[("eer", arm)].dropna() if ("eer", arm) in g else pd.Series(dtype=float)
            entry[f"auc_{arm}"] = float(a.mean()) if len(a) else None
            entry[f"eer_{arm}"] = float(e.mean()) if len(e) else None
            entry[f"n_{arm}"] = len(a)
        both = g.dropna(subset=[("auc", "v2"), ("auc", "baseline")]) if {("auc", "v2"), ("auc", "baseline")} <= set(g.columns) else g.iloc[:0]
        entry["v2_beats_baseline"] = f"{int((both[('auc', 'v2')] > both[('auc', 'baseline')]).sum())}/{len(both)}"
        summary.append(entry)
    return summary


def print_summary(summary, arms=None):
    arms = arms or ARMS
    for ev in ("heldout", "oof", "heldout_window60", "oof_window60"):
        print(f"\n== {ev}: mean AUC / mean EER over seeds (v2 AUC wins vs baseline)")
        for s in [x for x in summary if x["evaluation"] == ev]:
            cells = []
            for arm in arms:
                a, e = s[f"auc_{arm}"], s[f"eer_{arm}"]
                cells.append(f"{arm} {'   n/a    ' if a is None else f'{a:.3f}/{e:.3f}'} (n={s[f'n_{arm}']})")
            print(f"  sim={s['similarity']:<4} {s['modality']:>8}: " + "  ".join(cells) + f"  wins {s['v2_beats_baseline']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--run-dir", help="real run directory containing features.pkl")
    src.add_argument("--synthetic", action="store_true", help="seeded simulated pairs (development only)")
    ap.add_argument("--seeds", type=int, default=6)
    ap.add_argument("--similarity", type=float, nargs="+", default=[0.35, 0.6, 1.0])
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--output", help="write the JSON result here")
    args = ap.parse_args()
    if args.run_dir:
        from twobme_common.spec import load_spec

        run = Path(args.run_dir)
        df = pd.read_pickle(run / "features.pkl")
        if "synthetic" in df and df.synthetic.any():
            print("WARNING: run contains synthetic rows; this is not real-person evidence.")
        result = {"source": str(run), "real_data": not ("synthetic" in df and df.synthetic.any()),
                  "arms": compare(df, load_spec().model_dump())}
        for evaluation in ("heldout", "oof", "heldout_window60", "oof_window60"):
            print(f"\n{table(result['arms'], evaluation)}")
        for arm, res in result["arms"].items():
            print(f"{arm}: disabled heldout={res.get('heldout_disabled')} oof={res.get('oof_disabled')}")
        out = Path(args.output) if args.output else run / "gap-compare.json"
    else:
        jobs = [(seed, sim, ARMS) for sim in args.similarity for seed in range(1, args.seeds + 1)]
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            done = list(pool.map(synthetic_job, jobs))
        summary = summarize(done)
        print_summary(summary)
        result = {"synthetic": True, "warning": "Simulated people; development evidence only.",
                  "summary": summary, "jobs": done}
        out = Path(args.output) if args.output else None
    if out:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, indent=2, default=str, allow_nan=False) + "\n")
        print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
