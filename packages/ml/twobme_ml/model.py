from __future__ import annotations
from datetime import datetime, timezone
from pathlib import Path
import json
import uuid
import numpy as np
import pandas as pd
import joblib
from sklearn.preprocessing import RobustScaler
from sklearn.ensemble import IsolationForest
from sklearn.mixture import GaussianMixture
from sklearn.svm import OneClassSVM
from twobme_common.types import BlockScore, Deviation
from twobme_features.accumulators import names
from .config import model_config

GATES = {"keyboard": 100, "mouse": 60, "scroll": 30, "workflow": 20, "temporal": 60}
HEADLINES = set(
    "kb_hold_p50 kb_dd_p50 kb_ud_p50 kb_speed_kps kb_bksp_rate ms_v_p50 ms_curv_p50 ms_straightness_p50 ms_click_hold_p50 sc_v_mean_p50 wf_switch_rate tp_rate tp_b tp_idle_frac tp_peak_hz".split()
)
CATEGORIES = ["browser", "ide", "terminal", "chat", "docs", "media", "system", "other"]


def eligible(df, now=None, *, actor="a"):
    d = df.copy()
    now = pd.Timestamp(now or datetime.now(timezone.utc))
    base = d.get("baseline_eligible", pd.Series(False, index=d.index)).fillna(False)
    if "mode" in d:
        base = base | d["mode"].eq("enroll")
    upd = d.get("update_candidate", pd.Series(False, index=d.index)).fillna(False)
    times = pd.to_datetime(d["time"], utc=True)
    mask = base | (upd & (times <= now - pd.Timedelta(minutes=10)))
    mask &= d.get("actor", pd.Series("", index=d.index)).eq(actor)
    if actor == "a":
        mask &= ~d.get("label", pd.Series("", index=d.index)).eq("impostor")
    for col in ("takeover_excluded", "reset_session", "sandbox", "ephemeral"):
        if col in d:
            mask &= ~d[col].fillna(True).astype(bool)
    if "session_kind" in d:
        mask &= ~d.session_kind.isin(["sandbox", "ephemeral"])
    return d[mask].sort_values("time").reset_index(drop=True)


def temporal_subset(df):
    # Take every sixth context per session, preserving cadence across data gaps.
    mask = df.modality.ne("temporal")
    temporal = df[~mask]
    idx = temporal.groupby("session_id", sort=False).cumcount() % 6 == 0
    return (
        pd.concat([df[mask], temporal[idx]]).sort_values("time").reset_index(drop=True)
    )


def transition_matrix(rows):
    matrix = np.full((8, 8), 5 / 8, dtype=float)
    for extras in rows:
        for pair, n in ((extras or {}).get("transitions") or {}).items():
            if n is None:  # Parquet structs materialize absent keys as null.
                continue
            a, b = pair.split(">")
            if a in CATEGORIES and b in CATEGORIES:
                matrix[CATEGORIES.index(a), CATEGORIES.index(b)] += n
    return matrix / matrix.sum(axis=1, keepdims=True)


def markov_ll(transitions, matrix):
    total = 0
    num = 0
    for pair, n in (transitions or {}).items():
        if n is None:
            continue
        a, b = pair.split(">")
        if a in CATEGORIES and b in CATEGORIES:
            total += n * np.log(matrix[CATEGORIES.index(a), CATEGORIES.index(b)])
            num += n
    return float(total / num) if num else np.nan


class Ensemble:
    def fit(self, x, family_n=None):
        self.median = np.array(
            [np.nanmedian(c) if np.isfinite(c).any() else 0 for c in x.T]
        )
        x = np.where(np.isfinite(x), x, self.median)
        self.mad = np.median(np.abs(x - self.median), axis=0)
        self.scaler = RobustScaler().fit(x)
        z = self.scaler.transform(x)
        n = family_n or len(z)
        self.center = np.median(z, axis=0)
        self.members = [
            IsolationForest(
                n_estimators=500, max_samples=min(256, len(z)), random_state=17, n_jobs=1
            ).fit(z)
        ]
        if n >= 60:
            self.members.append(
                GaussianMixture(
                    n_components=2 if n > 150 else 1,
                    covariance_type="diag",
                    reg_covar=1e-3,
                    random_state=17,
                ).fit(z)
            )
        if n > 150:
            self.members.append(OneClassSVM(nu=0.05).fit(z))
        return self
    def raw(self, x):
        z = self.scaler.transform(np.where(np.isfinite(x), x, self.median))
        return np.column_stack(
            [np.abs(z - self.center).mean(axis=1)]
            + [-m.score_samples(z) for m in self.members]
        )


def rank_scores(raw, refs):
    return np.column_stack(
        [
            (np.searchsorted(np.sort(refs[:, j]), raw[:, j], side="left") + 0.5)
            / (len(refs) + 1)
            for j in range(raw.shape[1])
        ]
    ).mean(axis=1)


class UserModel:
    @classmethod
    def train(cls, df, cfg):
        cfg = model_config(cfg)
        gate_overrides = cfg.get("experimental_gates", {})
        lowered = {m: n for m, n in gate_overrides.items() if n < GATES.get(m, n)}
        if lowered and not cfg.get("allow_experimental_gate_override"):
            raise ValueError(
                "Lower enrollment gates require allow_experimental_gate_override=true: "
                + str(lowered)
            )
        gates = dict(GATES)
        gates.update(gate_overrides)
        min_fold_train = {m: 20 for m in GATES}
        min_fold_train.update(cfg.get("experimental_min_fold_train", {}))
        self = cls()
        self.cfg = cfg
        self.spec = cfg["spec"]
        self.schema_version = cfg.get("schema_version", 1)
        if len(df) and not df.schema_version.eq(self.schema_version).all():
            raise ValueError("Mixed or unsupported feature schema")
        d = temporal_subset(
            eligible(df, cfg.get("now"), actor=cfg.get("training_actor", "a"))
        )
        self.models = {}
        self.disabled = {}
        self.n_blocks = {}
        self.version = str(uuid.uuid4())
        self.parent_version = cfg.get("parent_version")
        self.trained_at = datetime.now(timezone.utc).isoformat()
        self.experimental = {
            "gate_overrides": lowered,
            "min_fold_train": {
                m: min_fold_train[m] for m in lowered
            },
            "warning": (
                "Below-contract enrollment gate; development/demo evidence only."
                if lowered else None
            ),
        }
        for modality, gate in gates.items():
            rows = d[d.modality == modality].sort_values("time").reset_index(drop=True)
            self.n_blocks[modality] = len(rows)
            required = max(min_fold_train[modality], gate)
            if len(rows) < required:
                self.disabled[modality] = (
                    f"Need {required} eligible blocks; have {len(rows)}"
                )
                continue
            columns = names(self.spec, modality)
            x = np.array([self._vector(f, columns) for f in rows.features], float)
            matrix = transition_matrix(rows.extras) if modality == "workflow" else None
            folds = np.array_split(np.arange(len(rows)), 5)
            raw_oof = []
            test_ids = []
            member_count = None
            times = (
                pd.to_datetime(rows.time, utc=True)
                .dt.as_unit("ns")
                .astype("int64")
                .to_numpy()
                / 1e9
            )
            starts = (
                pd.to_datetime(rows.block_start, utc=True)
                .dt.as_unit("ns")
                .astype("int64")
                .to_numpy()
                / 1e9
            )
            # Keep the deployed ensemble family across folds so every member has OOF references.
            train_splits = []
            for ix in folds:
                train = np.where(
                    (times < starts[ix].min() - 60) | (starts > times[ix].max() + 60)
                )[0]
                if len(train) < min_fold_train[modality]:
                    continue
                train_splits.append((train, ix))
            if len(train_splits) != 5:
                self.disabled[modality] = (
                    "Insufficient chronological coverage for five folds with 60s purge"
                )
                continue
            for train, ix in train_splits:
                foldx = x.copy()
                if matrix is not None:
                    fm = transition_matrix(rows.iloc[train].extras)
                    j = columns.index("wf.markov_ll")
                    foldx[:, j] = [
                        markov_ll((e or {}).get("transitions"), fm) for e in rows.extras
                    ]
                fit = Ensemble().fit(foldx[train], family_n=len(rows))
                r = fit.raw(foldx[ix])
                member_count = (
                    r.shape[1]
                    if member_count is None
                    else min(member_count, r.shape[1])
                )
                raw_oof.append(r)
                test_ids.extend(ix.tolist())
            refs = np.vstack([r[:, :member_count] for r in raw_oof])
            ensemble_ref = rank_scores(refs, refs)
            oof_typicality = (
                len(ensemble_ref)
                - np.searchsorted(np.sort(ensemble_ref), ensemble_ref, side="right")
                + 0.5
            ) / (len(ensemble_ref) + 1)
            if matrix is not None:
                x[:, columns.index("wf.markov_ll")] = [
                    markov_ll((e or {}).get("transitions"), matrix) for e in rows.extras
                ]
            fit = Ensemble().fit(x)
            self.models[modality] = {
                "fit": fit,
                "raw_ref": refs,
                "ref": np.sort(ensemble_ref),
                "columns": columns,
                "matrix": matrix,
                "folds": [
                    {"train": tr.tolist(), "test": te.tolist()}
                    for tr, te in train_splits
                ],
                "oof_typicality": oof_typicality.tolist(),
            }
        if not self.models:
            raise ValueError(
                "No modality meets enrollment and purged calibration gates: "
                + str(self.disabled)
            )
        return self

    @staticmethod
    def _vector(features, columns):
        if isinstance(features, dict):
            return [features.get(c, np.nan) for c in columns]
        if len(features) != len(columns):
            raise ValueError("Feature vector does not match canonical order")
        return features

    def score_block(self, block):
        m = self.models.get(block.modality)
        if m is None:
            return None
        x = np.array(self._vector(block.features, m["columns"]), float)
        if m["matrix"] is not None:
            x[m["columns"].index("wf.markov_ll")] = markov_ll(
                block.transitions, m["matrix"]
            )
        fit = m["fit"]
        raw = fit.raw(x[None, :])[:, : m["raw_ref"].shape[1]]
        score = rank_scores(raw, m["raw_ref"])[0]
        typicality = (
            len(m["ref"]) - np.searchsorted(m["ref"], score, side="right") + 0.5
        ) / (len(m["ref"]) + 1)
        z = (x - fit.median) / np.maximum(1.4826 * fit.mad, 1e-6)
        indices = sorted(
            np.where(np.isfinite(z))[0], key=lambda i: abs(z[i]), reverse=True
        )[:5]
        return BlockScore(
            modality=block.modality,
            t_end=block.t_end,
            n=block.n,
            typicality=float(typicality),
            llr_direct=None,
            top=[Deviation(feature=m["columns"][i], z=float(z[i])) for i in indices],
        )

    def save(self, d):
        p = Path(d)
        p.mkdir(parents=True, exist_ok=True)
        joblib.dump(self, p / "model.joblib")
        meta = {
            "version": self.version,
            "parent_version": self.parent_version,
            "trained_at": self.trained_at,
            "schema_version": self.schema_version,
            "n_blocks": self.n_blocks,
            "enabled_modalities": list(self.models),
            "disabled": self.disabled,
            "headline_medians": {
                c.replace(".", "_").lower(): float(m["fit"].median[i])
                for m in self.models.values()
                for i, c in enumerate(m["columns"])
                if c.replace(".", "_").lower() in HEADLINES
            },
            "calibration": "five chronological folds, 60s purged; OOF references saved",
            "experimental": getattr(self, "experimental", {
                "gate_overrides": {}, "min_fold_train": {}, "warning": None
            }),
        }
        (p / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")

    @classmethod
    def load(cls, d):
        # joblib is executable: callers must use only trusted, local model artifacts.
        obj = joblib.load(Path(d) / "model.joblib")
        if not isinstance(obj, cls):
            raise ValueError("Not a UserModel artifact")
        return obj
