"""Measured voice calibration primitives with no model loading or I/O."""

from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np

from .models import pinned_revision


def _finite(values: Sequence[float], name: str, minimum: int) -> np.ndarray:
    result = np.asarray(values, dtype=np.float64)
    if result.ndim != 1 or len(result) < minimum or not np.isfinite(result).all():
        raise ValueError(f"{name} requires at least {minimum} finite scores")
    return result


def auc_high(high: Sequence[float], low: Sequence[float]) -> float:
    """Pairwise AUC for a score whose positive class is expected to be high."""
    high = _finite(high, "positive class", 1)
    low = _finite(low, "negative class", 1)
    return float(np.mean((high[:, None] > low) + 0.5 * (high[:, None] == low)))


def operating_threshold(high: Sequence[float], low: Sequence[float]) -> dict:
    """Choose the measured high-is-positive threshold with minimum balanced error."""
    high = _finite(high, "positive class", 1)
    low = _finite(low, "negative class", 1)
    values = np.unique(np.concatenate([high, low]))
    candidates = np.concatenate(
        ([np.nextafter(values[0], -np.inf)], (values[:-1] + values[1:]) / 2, [values[-1]])
    )
    rows = []
    for threshold in candidates:
        false_negative = float(np.mean(high < threshold))
        false_positive = float(np.mean(low >= threshold))
        rows.append(
            (0.5 * (false_negative + false_positive), false_positive, false_negative, threshold)
        )
    error, false_positive, false_negative, threshold = min(rows)
    return {
        "threshold": float(threshold),
        "balanced_error": error,
        "false_positive_rate": false_positive,
        "false_negative_rate": false_negative,
    }


def _vectors(values, name: str, minimum: int) -> np.ndarray:
    rows = np.asarray(values, dtype=np.float64)
    if rows.ndim != 2 or len(rows) < minimum or not np.isfinite(rows).all():
        raise ValueError(f"{name} requires at least {minimum} finite vectors")
    norms = np.linalg.norm(rows, axis=1)
    if np.any(norms <= 1e-12):
        raise ValueError(f"{name} contains a zero vector")
    return rows


def leave_one_out_scores(values, *, name: str = "owner") -> np.ndarray:
    rows = _vectors(values, name, 2)
    references = rows.sum(axis=0) - rows
    norms = np.linalg.norm(references, axis=1)
    if np.any(norms <= 1e-12):
        raise ValueError(f"{name} cannot form leave-one-out references")
    probes = rows / np.linalg.norm(rows, axis=1)[:, None]
    return np.clip(np.sum(probes * (references / norms[:, None]), axis=1), -1, 1)


def reference_scores(reference, probes, *, name: str) -> np.ndarray:
    enrolled = _vectors(reference, "owner", 2)
    probes = _vectors(probes, name, 1)
    centroid = enrolled.mean(axis=0)
    norm = np.linalg.norm(centroid)
    if norm <= 1e-12:
        raise ValueError("owner cannot form a centroid")
    probes = probes / np.linalg.norm(probes, axis=1)[:, None]
    return np.clip(probes @ (centroid / norm), -1, 1)


def _require_separation(name: str, auc: float, operating_point: dict) -> None:
    if auc < 0.8 or operating_point["balanced_error"] > 0.2:
        raise ValueError(f"{name} separation is below the measured production gate")


def fit_logistic(real: Sequence[float], synthetic: Sequence[float]) -> tuple[float, float]:
    """Fit regularized synthetic-high logistic calibration with positive scale."""
    real = _finite(real, "real margins", 20)
    synthetic = _finite(synthetic, "synthetic margins", 20)
    if auc_high(synthetic, real) <= 0.5:
        raise ValueError("countermeasure direction is not synthetic-high")
    scores = np.concatenate([real, synthetic])
    labels = np.concatenate([np.zeros(len(real)), np.ones(len(synthetic))])
    mean, std = float(scores.mean()), float(scores.std())
    if std <= 1e-12:
        raise ValueError("countermeasure margins have no variation")
    z = (scores - mean) / std
    design = np.column_stack([z, np.ones(len(z))])
    theta = np.array([1.0, 0.0])
    regularization = 1e-3

    def objective(candidate):
        logits = design @ candidate
        return float(
            np.sum(np.logaddexp(0, logits) - labels * logits)
            + 0.5 * regularization * (candidate @ candidate)
        )

    for _ in range(100):
        logits = np.clip(design @ theta, -40, 40)
        probabilities = 1 / (1 + np.exp(-logits))
        gradient = design.T @ (probabilities - labels) + regularization * theta
        weights = probabilities * (1 - probabilities)
        hessian = design.T @ (weights[:, None] * design) + regularization * np.eye(2)
        step = np.linalg.solve(hessian, gradient)
        if np.linalg.norm(step) < 1e-10:
            break
        before = objective(theta)
        fraction = 1.0
        while fraction > 1e-8:
            candidate = theta - fraction * step
            if candidate[0] > 1e-8 and objective(candidate) < before:
                theta = candidate
                break
            fraction /= 2
        else:
            break
    scale = float(theta[0] / std)
    bias = float(theta[1] - theta[0] * mean / std)
    if not math.isfinite(scale) or scale <= 0 or not math.isfinite(bias):
        raise ValueError("unable to fit positive countermeasure calibration")
    return scale, bias


def _probabilities(values, scale: float, bias: float) -> np.ndarray:
    logits = np.clip(scale * np.asarray(values, dtype=np.float64) + bias, -40, 40)
    return 1 / (1 + np.exp(-logits))


def _summary(values: np.ndarray) -> dict:
    return {
        "min": float(np.min(values)),
        "p05": float(np.percentile(values, 5)),
        "median": float(np.median(values)),
        "p95": float(np.percentile(values, 95)),
        "max": float(np.max(values)),
    }


def fit_calibration(
    *,
    model: str,
    revision: str,
    speaker_revision: str,
    real_margins,
    synthetic_margins,
    owner_embeddings,
    impostor_embeddings,
    synthetic_embeddings,
    owner_spectral,
    impostor_spectral,
    synthetic_spectral,
) -> dict:
    """Fit thresholds from three disjoint, consented measured corpora."""
    pinned_revision(revision)
    pinned_revision(speaker_revision)
    real_margins = _finite(real_margins, "real margins", 20)
    synthetic_margins = _finite(synthetic_margins, "synthetic margins", 20)
    owner_embeddings = _vectors(owner_embeddings, "owner embeddings", 20)
    impostor_embeddings = _vectors(impostor_embeddings, "impostor embeddings", 10)
    synthetic_embeddings = _vectors(synthetic_embeddings, "synthetic embeddings", 20)
    owner_spectral = _vectors(owner_spectral, "owner spectral vectors", 20)
    impostor_spectral = _vectors(impostor_spectral, "impostor spectral vectors", 10)
    synthetic_spectral = _vectors(synthetic_spectral, "synthetic spectral vectors", 20)

    scale, bias = fit_logistic(real_margins, synthetic_margins)
    real_probability = _probabilities(real_margins, scale, bias)
    synthetic_probability = _probabilities(synthetic_margins, scale, bias)
    cm = operating_threshold(synthetic_probability, real_probability)
    cm_auc = auc_high(synthetic_probability, real_probability)
    _require_separation("countermeasure", cm_auc, cm)

    owner_asv = leave_one_out_scores(owner_embeddings)
    impostor_asv = reference_scores(owner_embeddings, impostor_embeddings, name="impostor")
    synthetic_asv = reference_scores(owner_embeddings, synthetic_embeddings, name="synthetic")
    asv_auc = auc_high(owner_asv, impostor_asv)
    if asv_auc <= 0.5:
        raise ValueError("speaker direction is not owner-high")
    asv_low_result = operating_threshold(owner_asv, impostor_asv)
    _require_separation("speaker", asv_auc, asv_low_result)
    asv_low = asv_low_result["threshold"]
    asv_high = float(np.min(owner_asv) - 0.03)
    if not -1 <= asv_low < asv_high <= 1:
        raise ValueError("speaker corpora do not support ordered low/high thresholds")

    owner_spec = leave_one_out_scores(owner_spectral, name="owner spectral vectors")
    impostor_spec = reference_scores(owner_spectral, impostor_spectral, name="impostor spectral")
    synthetic_spec = reference_scores(owner_spectral, synthetic_spectral, name="synthetic spectral")
    spectral_auc = auc_high(owner_spec, impostor_spec)
    if spectral_auc <= 0.5:
        raise ValueError("spectral direction is not owner-high")
    spectral = operating_threshold(owner_spec, impostor_spec)
    _require_separation("spectral", spectral_auc, spectral)

    return {
        "model": model,
        "revision": revision,
        "speaker_revision": speaker_revision,
        "thresholds": {
            "asv_low": asv_low,
            "asv_high": asv_high,
            "cm": cm["threshold"],
            "spectral": spectral["threshold"],
        },
        "cm_scale": scale,
        "cm_bias": bias,
        "evidence": {
            "method": "three-corpus-v1",
            "counts": {
                "owner": len(owner_embeddings),
                "human_impostor": len(impostor_embeddings),
                "synthetic_clone": len(synthetic_embeddings),
            },
            "cm": {
                "auc_synthetic_high": cm_auc,
                "operating_point": cm,
                "owner_probability": _summary(real_probability),
                "synthetic_probability": _summary(synthetic_probability),
            },
            "asv": {
                "auc_owner_high": asv_auc,
                "low_operating_point": asv_low_result,
                "high_rule": "minimum owner leave-one-out cosine minus 0.03",
                "owner": _summary(owner_asv),
                "human_impostor": _summary(impostor_asv),
                "synthetic_clone": _summary(synthetic_asv),
            },
            "spectral": {
                "auc_owner_high": spectral_auc,
                "operating_point": spectral,
                "owner": _summary(owner_spec),
                "human_impostor": _summary(impostor_spec),
                "synthetic_clone": _summary(synthetic_spec),
            },
        },
    }
