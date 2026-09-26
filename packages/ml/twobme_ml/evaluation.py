"""Held-out identity evidence. Synthetic data and missing live trials are explicit."""

from datetime import datetime, timezone
import numpy as np
import pandas as pd
from sklearn.metrics import roc_curve, roc_auc_score, confusion_matrix
from twobme_common.types import Block
from .model import ACTIVE_MODALITIES, UserModel, temporal_subset, GATES


def roc_metrics(genuine, impostor):
    if not genuine or not impostor:
        return {
            "auc": None,
            "eer": None,
            "roc": [],
            "n_genuine": len(genuine),
            "n_impostor": len(impostor),
        }
    y = [1] * len(genuine) + [0] * len(impostor)
    scores = list(genuine) + list(impostor)
    fpr, tpr, _ = roc_curve(y, scores)
    dif = fpr - (1 - tpr)
    cross = np.flatnonzero(dif >= 0)
    i = int(cross[0]) if len(cross) else len(fpr) - 1
    if i == 0:
        eer = float((fpr[0] + 1 - tpr[0]) / 2)
    else:
        w = -dif[i - 1] / (dif[i] - dif[i - 1]) if dif[i] != dif[i - 1] else 0
        eer = float(fpr[i - 1] + w * (fpr[i] - fpr[i - 1]))
    take = np.unique(np.linspace(0, len(fpr) - 1, min(200, len(fpr))).astype(int))
    return {
        "auc": float(roc_auc_score(y, scores)),
        "eer": eer,
        "roc": [[float(fpr[i]), float(tpr[i])] for i in take],
        "n_genuine": len(genuine),
        "n_impostor": len(impostor),
    }


def beta_mle(typicalities):
    a = np.array(typicalities, dtype=float)
    estimate = (
        float(-len(a) / np.log1p(-np.minimum(a, 1 - 1e-6)).sum())
        if len(a) and np.any(a > 0)
        else 0
    )
    weak = len(a) < 10 or estimate < 2
    return (6.0 if weak else float(np.clip(estimate, 2, 20))), weak


def minimum_prefix_split(df, modality):
    """Predefined minimum enrollment prefix, then future blocks after a 60s gap.

    Supplements the global split for sparse modalities; never searches cutoffs
    for a favorable metric. Temporal rows are downsampled only for this selection.
    """
    from .model import eligible

    rows = temporal_subset(eligible(df))
    rows = rows[rows.modality == modality].sort_values("time")
    gate = GATES[modality]
    train = rows.iloc[:gate]
    if len(train) < gate:
        return train, rows.iloc[:0]
    test = rows[rows.block_start > train.time.max() + pd.Timedelta(seconds=60)]
    return train, test


def block_from_row(row, spec):
    from twobme_features.accumulators import names

    fs = row["features"]
    fs = fs if isinstance(fs, dict) else dict(zip(names(spec, row["modality"]), fs))
    return Block(
        modality=row["modality"],
        t_start=pd.Timestamp(row["block_start"]).to_pydatetime(warn=False),
        t_end=pd.Timestamp(row["time"]).to_pydatetime(warn=False),
        n=int(row["n"]),
        features=fs,
        transitions={k: v for k, v in ((row.get("extras") or {}).get("transitions") or {}).items()
                     if v is not None},
    )


def live_trials(markers, ticks):
    trials = []
    starts = [m for m in markers if m["label"] == "takeover_start"]
    for j, marker in enumerate(starts):
        start = pd.Timestamp(marker["t"])
        end = (
            pd.Timestamp(starts[j + 1]["t"])
            if j + 1 < len(starts)
            else start + pd.Timedelta(seconds=300)
        )
        end = min(end, start + pd.Timedelta(seconds=300))
        for m in markers:
            mt = pd.Timestamp(m["t"])
            if m["label"] == "takeover_end" and start < mt < end:
                end = mt
        run = 0
        ttd = None
        for tick in sorted(ticks, key=lambda t: t["t"]):
            t = pd.Timestamp(tick["t"])
            if not start <= t < end:
                continue
            run = run + 1 if tick["confidence"] < 0.4 else 0
            if run >= 2:
                ttd = (t - start).total_seconds()
                break
        trials.append(
            {"t_start": start.isoformat(), "ttd_s": ttd, "detected": ttd is not None}
        )
    return trials


def heldout_scores(df, cfg):
    """Official held-out split and block scores behind `evaluate`.

    Returns the A (and, if trainable, B) models, per-actor typicality series by modality,
    one record per scored block (actor, session, modality, time, typicality), and the
    identification truth/prediction pairs.
    """
    a = df[(df.actor == "a") & (df.label == "genuine")].sort_values("time")
    b = df[(df.actor == "b") & (df.label == "impostor")].sort_values("time")
    if len(a) < 2 or len(b) < 2:
        raise ValueError("Evaluation needs both A genuine and B impostor data")
    cut = pd.Timestamp(a.iloc[int(len(a) * 0.7)]["block_start"])
    bcut = pd.Timestamp(b.iloc[int(len(b) * 0.7)]["block_start"])
    atrain = a[pd.to_datetime(a.time, utc=True) < cut - pd.Timedelta(seconds=60)]
    atest = a[pd.to_datetime(a.block_start, utc=True) >= cut]
    btrain = b[
        pd.to_datetime(b.time, utc=True) < bcut - pd.Timedelta(seconds=60)
    ].copy()
    btest = b[pd.to_datetime(b.block_start, utc=True) >= bcut]
    am = UserModel.train(atrain, cfg)
    # B is a separate identification identity; never admitted to A's baseline.
    btrain["baseline_eligible"] = True
    b_model_note = None
    try:
        bm = UserModel.train(btrain, dict(cfg, training_actor="b"))
    except ValueError as exc:
        if not str(exc).startswith(
            "No modality meets enrollment and purged calibration gates:"
        ):
            raise
        bm = None
        # A-only anomaly detection does not require an enrolled impostor model.
        # No B rows were fit, so the entire short B recording can be held out.
        btest = b
        b_model_note = (
            "Two-way identification unavailable: B has insufficient enrollment/calibration data. "
            "All B rows are held out from A training and used only for impostor evaluation. "
            "Do not interpret this as a two-identity identification benchmark."
        )
    atest = temporal_subset(atest)
    btest = temporal_subset(btest)
    series = {"a": {}, "b": {}}
    records = []
    truth = []
    pred = []
    for actor, rows in [("a", atest), ("b", btest)]:
        for _, row in rows.iterrows():
            block = block_from_row(row, cfg["spec"])
            sa = am.score_block(block)
            sb = bm.score_block(block) if bm is not None else None
            if sa:
                series[actor].setdefault(block.modality, []).append(
                    (pd.Timestamp(row.time), sa.typicality)
                )
                records.append(
                    {"actor": actor, "session": row.session_id, "modality": block.modality,
                     "t": pd.Timestamp(row.time), "typicality": sa.typicality}
                )
            if sa and sb:
                truth.append(actor)
                pred.append("a" if sa.typicality >= sb.typicality else "b")
    return {"a_model": am, "b_model": bm, "b_model_note": b_model_note, "series": series,
            "records": records, "truth": truth, "pred": pred}


def evaluate(df, cfg, markers=(), ticks=(), held=None):
    held = held or heldout_scores(df, cfg)
    am, bm, b_model_note = held["a_model"], held["b_model"], held["b_model_note"]
    series, truth, pred = held["series"], held["truth"], held["pred"]
    results = {}
    for m in ACTIVE_MODALITIES:
        ga = [t for _, t in series["a"].get(m, [])]
        im = [t for _, t in series["b"].get(m, [])]
        beta, weak = beta_mle(im)
        results[m] = dict(roc_metrics(ga, im), beta=beta, weak=weak)

    def fused(actor, removed=None):
        # Group independent block evidence in non-overlapping 60s wall-clock bins.
        rows = [
            (int(t.timestamp() // 60), m, v)
            for m, ss in series[actor].items()
            if m != removed
            for t, v in ss
        ]
        groups = {}
        for bucket, m, v in rows:
            groups.setdefault(bucket, {}).setdefault(m, []).append(v)
        weights = cfg.get(
            "weights",
            {
                "keyboard": 1,
                "mouse": 1,
                "scroll": 0.5,
            },
        )
        return [
            sum(np.mean(v) * weights[m] for m, v in g.items())
            / sum(weights[m] for m in g)
            for g in groups.values()
        ]

    notes = [
        f"Disabled A modalities: {am.disabled}",
        f"Disabled B modalities: {bm.disabled}" if bm is not None else b_model_note,
        "A uses a chronological 70/30 split with 60s purge. B uses the same split when a B model can be trained; otherwise all B rows are evaluation-only. Fused ROC uses non-overlapping 60s bins; per-modality ROC uses blocks.",
    ]
    if "synthetic" in df and df.synthetic.any():
        notes.append(
            "SYNTHETIC DATA ONLY — validates the pipeline, not real-person identity performance."
        )
    trials = live_trials(markers, ticks)
    if len(trials) < 5:
        notes.append(
            f"Live acceptance incomplete: {len(trials)}/5 marked takeover trials supplied."
        )
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "n_blocks": {
            actor: {m: len(v) for m, v in series[actor].items()} for actor in series
        },
        "modalities": results,
        "fused": {
            k: v
            for k, v in roc_metrics(fused("a"), fused("b")).items()
            if k in ("auc", "eer")
        },
        "ablation": [
            {
                "removed": m,
                "fused_eer": roc_metrics(fused("a", m), fused("b", m))["eer"],
            }
            for m in results
        ],
        "identification": {
            "labels": ["a", "b"],
            "confusion": confusion_matrix(truth, pred, labels=["a", "b"]).tolist()
            if truth
            else [[0, 0], [0, 0]],
            "accuracy": float(np.mean(np.array(truth) == np.array(pred)))
            if truth
            else None,
        },
        "live_trials": trials,
        "notes": notes,
    }
