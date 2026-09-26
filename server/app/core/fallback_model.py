"""Fallback per-user model: used only when `twobme_ml` isn't installed (walking skeleton, local e2e,
or if the real model fails to load on stage). Codex 1's `twobme_ml.UserModel` is the real model.

Per modality: robust scaling (median / 1.4826·MAD), anomaly score s = mean |z| over non-null
features, typicality t = (#{reference scores ≥ s} + 0.5) / (n_ref + 1) against out-of-fold
reference scores (5 contiguous folds), so t ≈ U(0,1) for the genuine user. Modalities with fewer
than 20 training blocks are disabled.
"""

from __future__ import annotations

import json
import math
import warnings
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

from twobme_common.spec import MODALITIES, load_spec
from twobme_common.types import Block, BlockScore, Deviation

MIN_BLOCKS = 20
N_FOLDS = 5


def _fit_scale(X: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    with warnings.catch_warnings():  # all-NaN columns (never-observed features) are expected
        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(X, axis=0)
        mad = np.nanmedian(np.abs(X - med), axis=0) * 1.4826
        iqr_fallback = np.nanstd(X, axis=0)
    scale = np.where((mad > 1e-9) & np.isfinite(mad), mad, np.where(iqr_fallback > 1e-9, iqr_fallback, 1.0))
    med = np.where(np.isfinite(med), med, 0.0)
    return med, scale


def _scores(X: np.ndarray, med: np.ndarray, scale: np.ndarray) -> np.ndarray:
    Z = np.abs((X - med) / scale)
    Z = np.minimum(Z, 10.0)
    with warnings.catch_warnings(), np.errstate(invalid="ignore"):
        warnings.simplefilter("ignore", RuntimeWarning)
        s = np.nanmean(Z, axis=1)
    return np.where(np.isfinite(s), s, 0.0)


class FallbackUserModel:
    backend = "fallback"

    def __init__(self, version: int = 1):
        self.version = version
        self.params: dict[str, dict[str, Any]] = {}
        self.meta: dict[str, Any] = {}

    # --- training ------------------------------------------------------------------------------
    @classmethod
    def train(cls, df: Any, cfg: Any = None, version: int = 1) -> FallbackUserModel:
        """df columns: time, modality, features (list in spec order), label, actor, ..."""
        spec = load_spec()
        m = cls(version)
        n_blocks: dict[str, int] = {}
        medians: dict[str, float | None] = {}
        for mod in MODALITIES:
            rows = df[df["modality"] == mod].sort_values("time") if len(df) else df
            n_blocks[mod] = int(len(rows))
            if len(rows) < MIN_BLOCKS:
                continue
            X = np.array([[np.nan if v is None else float(v) for v in f] for f in rows["features"]], dtype=float)
            # drop features that are never observed
            keep = ~np.all(np.isnan(X), axis=0)
            med, scale = _fit_scale(X)
            # out-of-fold reference scores
            ref = np.empty(len(X))
            folds = np.array_split(np.arange(len(X)), N_FOLDS)
            for idx in folds:
                train_idx = np.setdiff1d(np.arange(len(X)), idx)
                fm, fs = _fit_scale(X[train_idx])
                ref[idx] = _scores(X[idx][:, keep], fm[keep], fs[keep])
            m.params[mod] = {
                "median": med.tolist(), "scale": scale.tolist(), "keep": keep.tolist(),
                "ref": np.sort(ref).tolist(),
            }
            for f, name in zip(spec.modalities[mod].features, spec.names(mod), strict=True):
                if f.headline:
                    i = spec.names(mod).index(name)
                    medians[f.column] = None if not np.isfinite(med[i]) else float(med[i])
        m.meta = {
            "backend": cls.backend, "version": version, "trained_at": datetime.now(UTC).isoformat(),
            "n_blocks": n_blocks, "enabled_modalities": list(m.params), "headline_medians": medians,
            "metrics": {}, "schema_version": spec.schema_version,
        }
        return m

    # --- scoring -------------------------------------------------------------------------------
    def score_block(self, block: Block) -> BlockScore | None:
        p = self.params.get(block.modality)
        if p is None:
            return None
        spec = load_spec()
        names = spec.names(block.modality)
        x = np.array([np.nan if block.features.get(n) is None else float(block.features[n]) for n in names])
        if np.all(np.isnan(x)):
            return None
        med, scale, keep = np.array(p["median"]), np.array(p["scale"]), np.array(p["keep"], dtype=bool)
        s = float(_scores(x[None, keep], med[keep], scale[keep])[0])
        ref = np.array(p["ref"])
        n_more = len(ref) - int(np.searchsorted(ref, s, side="left"))
        t = (n_more + 0.5) / (len(ref) + 1)
        z = (x - med) / scale
        top = sorted(
            (Deviation(feature=n, z=float(zi)) for n, zi, k in zip(names, z, keep, strict=True)
             if k and math.isfinite(zi)),
            key=lambda d: -abs(d.z),
        )[:5]
        return BlockScore(modality=block.modality, t_end=block.t_end, n=block.n, typicality=t, llr_direct=None,
                          top=top)

    # --- io --------------------------------------------------------------------------------------
    def save(self, d: Path) -> None:
        d.mkdir(parents=True, exist_ok=True)
        (d / "fallback_model.json").write_text(json.dumps({"version": self.version, "params": self.params}))
        (d / "meta.json").write_text(json.dumps(self.meta, indent=2))

    @classmethod
    def load(cls, d: Path) -> FallbackUserModel:
        data = json.loads((d / "fallback_model.json").read_text())
        m = cls(data["version"])
        m.params = data["params"]
        meta = d / "meta.json"
        m.meta = json.loads(meta.read_text()) if meta.is_file() else {}
        return m
