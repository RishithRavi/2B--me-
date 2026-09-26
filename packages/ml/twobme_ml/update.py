"""Explicit, fail-closed manual model updates. No automatic schedule."""

import os
import pandas as pd
import numpy as np
from .model import UserModel, eligible
from .evaluation import block_from_row, roc_metrics


def retrain(current, training, anchor_holdout, impostor_holdout, candidates, cfg):
    if os.environ.get("CONTINUOUS_UPDATE", "true").lower() == "false":
        raise ValueError("Continuous updates are frozen")
    required = {
        "update_candidate",
        "takeover_excluded",
        "reset_session",
        "session_kind",
        "label",
        "actor",
        "time",
        "baseline_eligible",
        "is_anchor",
    }
    if not required <= set(candidates):
        raise ValueError("Missing candidate exclusion/provenance fields")
    if len(anchor_holdout) == 0 or len(impostor_holdout) == 0:
        raise ValueError("Untouched anchor and B holdouts are required")
    if "is_anchor" not in training:
        raise ValueError("Training rows must identify enrollment anchors")
    now = pd.Timestamp(cfg.get("now") or pd.Timestamp.now(tz="UTC"))
    safe = candidates[
        candidates.update_candidate
        & (pd.to_datetime(candidates.time, utc=True) <= now - pd.Timedelta(minutes=10))
    ]
    safe = eligible(safe, now)
    safe = safe[~safe.is_anchor]
    # At most 10% replacements, preserving population size and all protected anchors.
    limit = int(len(training) * 0.1)
    replacement = safe.sort_values("time").tail(limit) if limit else safe.iloc[:0]
    if len(replacement) == 0:
        raise ValueError("No quarantined candidates within the 10% update budget")
    anchors = training[training.is_anchor]
    other = training[~training.is_anchor]
    if len(anchors) < 0.3 * len(training):
        raise ValueError("Enrollment anchor must be at least 30%")
    replacement = replacement.tail(len(other))
    if replacement.empty:
        raise ValueError("No replaceable non-anchor rows")
    merged = pd.concat(
        [anchors, other.sort_values("time").iloc[len(replacement) :], replacement],
        ignore_index=True,
    )
    keys = ["session_id", "modality", "time"]
    holdout_keys = set(
        map(
            tuple,
            pd.concat([anchor_holdout, impostor_holdout])[keys].astype(str).to_numpy(),
        )
    )
    if any(tuple(x) in holdout_keys for x in merged[keys].astype(str).to_numpy()):
        raise ValueError("Holdout leakage into training")
    fresh = UserModel.train(merged, dict(cfg, parent_version=current.version))
    if not set(current.models) <= set(fresh.models):
        raise ValueError("Update disabled a previously enabled modality")
    for m in current.models:

        def scores(model, rows):
            return [
                s.typicality
                for _, r in rows[rows.modality == m].iterrows()
                if (s := model.score_block(block_from_row(r, cfg["spec"]))) is not None
            ]

        old_a, new_a = scores(current, anchor_holdout), scores(fresh, anchor_holdout)
        old_b, new_b = (
            scores(current, impostor_holdout),
            scores(fresh, impostor_holdout),
        )
        if not old_a or not old_b:
            raise ValueError(f"Missing holdout coverage for {m}")
        if np.median(new_a) < np.median(old_a):
            raise ValueError(f"Anchor typicality regressed for {m}")
        if roc_metrics(new_a, new_b)["eer"] > roc_metrics(old_a, old_b)["eer"] + 0.01:
            raise ValueError(f"B EER regressed by more than one point for {m}")
    return fresh
