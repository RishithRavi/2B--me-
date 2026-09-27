from __future__ import annotations
from datetime import datetime, timezone
from itertools import pairwise
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

# The wire contract still accepts every historical modality, but identity models use only
# the three signals that separated the real owner/impostor recordings reliably.
ACTIVE_MODALITIES = ("keyboard", "mouse", "scroll")
# Fallback values for the full schema. `enroll_gate` in feature_spec.yaml remains the
# source of truth when reading old artifacts and diagnostic data.
GATES = {"keyboard": 100, "mouse": 60, "scroll": 30, "workflow": 13, "temporal": 60}
HEADLINES = set(
    "kb_hold_p50 kb_dd_p50 kb_ud_p50 kb_speed_kps kb_bksp_rate ms_v_p50 ms_curv_p50 ms_straightness_p50 ms_click_hold_p50 sc_v_mean_p50".split()
)
CATEGORIES = ["browser", "ide", "terminal", "chat", "docs", "media", "system", "other"]
# v2 view: fractions, ratios, scores, entropies and log-likelihoods stay linear. Every other
# feature is a duration, speed, rate or count whose spread grows with its level: signed log.
LINEAR = frozenset(
    """kb.rollover_frac kb.pause_rate kb.bksp_rate kb.chord_rate
    ms.straightness_p50 ms.t_peak_frac_p50 ms.frac_pc ms.frac_dd ms.dir_entropy
    sc.reversal_rate sc.momentum_frac sc.horizontal_frac wf.kbd_switch_frac wf.markov_ll
    tp.B tp.Bn tp.M tp.idle_frac tp.spec_entropy tp.acf_peak""".split()
)
# Welch band powers arrive absolute (they scale with activity volume); v2 uses their shares.
BAND_POWERS = ("tp.bp_0_05", "tp.bp_05_2", "tp.bp_2_5", "tp.bp_5_10", "tp.bp_10_25")


def enrollment_gates(spec):
    modalities = spec.get("modalities", {}) if isinstance(spec, dict) else {}
    return {
        m: int((modalities.get(m) or {}).get("enroll_gate") or gate)
        for m, gate in GATES.items()
    }


def fold_minimum(gate):
    # Five chronological folds with a 60s purge leave about 0.8*gate - 2 training blocks
    # per fold from a gate-sized enrollment (13 workflow blocks -> 8); capped at 20.
    return min(20, max(5, int(0.8 * gate) - 2))


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
    """Detector "v1": the original CP0 ensemble, kept verbatim for comparison and rollback."""

    def fit(self, x, family_n=None, columns=None):
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

    def zscores(self, x):
        return (x - self.median) / np.maximum(1.4826 * self.mad, 1e-6)


class EnsembleV2:
    """Detector "v2": missing-aware robust ensemble for small, heterogeneous enrollments.

    Every member scores anomaly (higher = stranger) on a view of the canonical vector:
    band powers become shares, durations/speeds/counts are log-compressed, and each
    feature is robust-scaled with a floor and clipped so no single feature dominates.
    - tail: per-feature nonparametric surprise, -log of the two-sided empirical tail
      probability, plus -log P(missing | present) under the owner's own missing rates.
    - dist: scaled Manhattan over the features the block actually observed.
    - knn: mean distance to the k nearest enrollment blocks (keeps context clusters).
    - gmm (n >= 60) and ocsvm (n > 150) on the clipped view.
    Missing values are never imputed as typical for tail, dist or knn. An isolation forest
    ("iforest") is available via `members` but is off by default: in simulated A/B
    ablations it added nothing on top of these members while dominating artifact size
    and scoring time.
    """

    def __init__(self, members=None, clip=4.0, log_view=True, band_shares=True):
        self.members_wanted = members
        self.clip = clip
        self.log_view = log_view
        self.band_shares = band_shares

    def fit(self, x, family_n=None, columns=None):
        x = np.where(np.isfinite(x), x, np.nan).astype(float)
        n, d = x.shape
        columns = list(columns) if columns is not None else [str(j) for j in range(d)]
        seen = np.isfinite(x).any(axis=0)
        # Raw-space medians feed headline medians and explanations only.
        self.median = np.where(seen, np.nanmedian(np.where(seen, x, 0), axis=0), 0.0)
        self.bands = (
            [columns.index(c) for c in BAND_POWERS if c in columns] if self.band_shares else []
        )
        self.logged = np.array(
            [self.log_view and c not in LINEAR and j not in self.bands for j, c in enumerate(columns)]
        )
        magnitude = np.abs(x)
        magnitude[magnitude == 0] = np.nan
        has = np.isfinite(magnitude).any(axis=0)
        s0 = np.nanmedian(np.where(has, magnitude, 1.0), axis=0)
        self.s0 = np.where(has & (s0 > 0), s0, 1.0)
        v = self._view(x)
        obs = np.isfinite(v)
        filled = np.where(obs.any(axis=0), v, 0.0)
        self.center = np.nanmedian(filled, axis=0)
        q05, q25, q75, q95 = np.nanpercentile(filled, [5, 25, 75, 95], axis=0)
        mad = np.nanmedian(np.abs(filled - self.center), axis=0)
        floor = np.where(self.logged, 0.05, 1e-3)
        self.scale = np.max(
            [(q75 - q25) / 1.349, 1.4826 * mad, 0.1 * (q95 - q05), floor], axis=0
        )
        self.sorted = [np.sort(v[obs[:, j], j]) for j in range(d)]
        self.p_missing = ((~obs).sum(axis=0) + 0.5) / (n + 1)
        self.train_z = self._z(v)
        self.k = int(np.clip(round(np.sqrt(n) / 2), 2, 10))
        family = family_n or n
        if self.members_wanted:
            self.member_names = list(self.members_wanted)
        else:
            self.member_names = ["tail", "dist", "knn"]
            self.member_names += ["gmm"] if family >= 60 else []
            self.member_names += ["ocsvm"] if family > 150 else []
        zi = np.nan_to_num(self.train_z)
        self.models = {}
        if "iforest" in self.member_names:
            self.models["iforest"] = IsolationForest(
                n_estimators=200, max_samples=min(256, n), random_state=17, n_jobs=1
            ).fit(zi)
        if "gmm" in self.member_names:
            self.models["gmm"] = GaussianMixture(
                n_components=2 if family > 150 else 1,
                covariance_type="diag",
                reg_covar=1e-3,
                random_state=17,
            ).fit(zi)
        if "ocsvm" in self.member_names:
            self.models["ocsvm"] = OneClassSVM(nu=0.05).fit(zi)
        return self

    def _view(self, x):
        v = np.where(np.isfinite(x), x, np.nan).astype(float)
        if self.bands:
            b = v[:, self.bands]
            total = b.sum(axis=1, keepdims=True)
            with np.errstate(invalid="ignore", divide="ignore"):
                v[:, self.bands] = np.where(total > 0, b / total, np.nan)
        if self.logged.any():
            lg = self.logged
            v[:, lg] = np.sign(v[:, lg]) * np.log1p(np.abs(v[:, lg]) / self.s0[lg])
        return v

    def _z(self, v):
        return np.clip((v - self.center) / self.scale, -self.clip, self.clip)

    def _tail(self, v):
        obs = np.isfinite(v)
        total = np.zeros(len(v))
        for j, ref in enumerate(self.sorted):
            pm = self.p_missing[j]
            s = np.full(len(v), -np.log(pm))
            o = obs[:, j]
            s[o] = -np.log1p(-pm)
            if o.any() and len(ref):
                q = v[o, j]
                lo = np.searchsorted(ref, q, "left")
                hi = np.searchsorted(ref, q, "right")
                f = (lo + 0.5 * (hi - lo) + 0.5) / (len(ref) + 1)
                s[o] -= np.log(np.minimum(1.0, 2 * np.minimum(f, 1 - f)))
            total += s
        return total / max(1, len(self.sorted))

    def _knn(self, z):
        out = np.empty(len(z))
        for i, q in enumerate(z):
            diff = np.abs(self.train_z - q)
            count = np.isfinite(diff).sum(axis=1)
            dist = np.where(
                count > 0, np.nansum(diff, axis=1) / np.maximum(count, 1), 2 * self.clip
            )
            k = min(self.k, len(dist))
            out[i] = np.partition(dist, k - 1)[:k].mean()
        return out

    def raw(self, x):
        v = self._view(np.atleast_2d(np.asarray(x, float)))
        z = self._z(v)
        cols = []
        for name in self.member_names:
            if name == "tail":
                cols.append(self._tail(v))
            elif name == "dist":
                a = np.abs(z)
                count = np.isfinite(a).sum(axis=1)
                cols.append(np.nansum(a, axis=1) / np.maximum(count, 1))
            elif name == "knn":
                cols.append(self._knn(z))
            else:
                cols.append(-self.models[name].score_samples(np.nan_to_num(z)))
        return np.column_stack(cols)

    def zscores(self, x):
        v = self._view(np.atleast_2d(np.asarray(x, float)))[0]
        return (v - self.center) / self.scale


DETECTORS = {"v1": Ensemble, "v2": EnsembleV2}
DEFAULT_DETECTOR = "v2"


def rank_scores(raw, refs, self_ranked=False):
    # A reference ranked against its own pool has only n-1 others, so it gets the n-point
    # grid; a new block gets the (n+1)-point grid. Both are then exactly uniform.
    denominator = len(refs) if self_ranked else len(refs) + 1
    return np.column_stack(
        [
            (np.searchsorted(np.sort(refs[:, j]), raw[:, j], side="left") + 0.5)
            / denominator
            for j in range(raw.shape[1])
        ]
    ).mean(axis=1)


class UserModel:
    @classmethod
    def train(cls, df, cfg):
        cfg = model_config(cfg)
        spec_gates = enrollment_gates(cfg["spec"])
        gate_overrides = {
            m: n
            for m, n in cfg.get("experimental_gates", {}).items()
            if m in ACTIVE_MODALITIES
        }
        lowered = {m: n for m, n in gate_overrides.items() if n < spec_gates.get(m, n)}
        if lowered and not cfg.get("allow_experimental_gate_override"):
            raise ValueError(
                "Lower enrollment gates require allow_experimental_gate_override=true: "
                + str(lowered)
            )
        gates = {m: spec_gates[m] for m in ACTIVE_MODALITIES}
        gates.update(gate_overrides)
        min_fold_train = {m: fold_minimum(g) for m, g in gates.items()}
        min_fold_train.update(cfg.get("experimental_min_fold_train", {}))
        detector = cfg.get("detector") or DEFAULT_DETECTOR
        if detector not in DETECTORS:
            raise ValueError(f"Unknown detector {detector!r}; expected one of {list(DETECTORS)}")
        options = cfg.get("detector_options") or {}
        calibration = cfg.get("calibration") or ("cv+" if detector == "v2" else "full")
        if calibration not in ("cv+", "full"):
            raise ValueError(f"Unknown calibration {calibration!r}; expected 'cv+' or 'full'")
        self = cls()
        self.cfg = cfg
        self.detector = detector
        self.calibration = calibration
        self.spec = cfg["spec"]
        self.schema_version = cfg.get("schema_version", 1)
        if len(df) and not df.schema_version.eq(self.schema_version).all():
            raise ValueError("Mixed or unsupported feature schema")
        base = eligible(df, cfg.get("now"), actor=cfg.get("training_actor", "a"))
        d = base[base.modality.isin(ACTIVE_MODALITIES)].sort_values("time").reset_index(drop=True)
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
            fold_train_min = min_fold_train[modality]
            columns = names(self.spec, modality)
            x = np.array([self._vector(f, columns) for f in rows.features], float)
            matrix = None
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
                if len(train) < fold_train_min:
                    continue
                train_splits.append((train, ix))
            if len(train_splits) != 5:
                self.disabled[modality] = (
                    "Insufficient chronological coverage for five folds with 60s purge"
                )
                continue
            fold_fits, fold_matrices = [], []
            for train, ix in train_splits:
                foldx = x.copy()
                fm = None
                if matrix is not None:
                    fm = transition_matrix(rows.iloc[train].extras)
                    j = columns.index("wf.markov_ll")
                    foldx[:, j] = [
                        markov_ll((e or {}).get("transitions"), fm) for e in rows.extras
                    ]
                fit = DETECTORS[detector](**options).fit(
                    foldx[train], family_n=len(rows), columns=columns
                )
                r = fit.raw(foldx[ix])
                member_count = (
                    r.shape[1]
                    if member_count is None
                    else min(member_count, r.shape[1])
                )
                raw_oof.append(r)
                test_ids.extend(ix.tolist())
                fold_fits.append(fit)
                fold_matrices.append(fm)
            refs = np.vstack([r[:, :member_count] for r in raw_oof])
            conformal = calibration == "cv+"
            ensemble_ref = rank_scores(refs, refs, self_ranked=conformal)
            oof_typicality = (
                len(ensemble_ref)
                - np.searchsorted(np.sort(ensemble_ref), ensemble_ref, side="right")
                + 0.5
            ) / (len(ensemble_ref) + (0 if conformal else 1))
            if matrix is not None:
                x[:, columns.index("wf.markov_ll")] = [
                    markov_ll((e or {}).get("transitions"), matrix) for e in rows.extras
                ]
            fit = DETECTORS[detector](**options).fit(x, columns=columns)
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
            if calibration == "cv+":
                # Cross-conformal scoring: a new block is compared, fold by fold, only with
                # the held-out blocks that the same fold model scored. The full-data model
                # is not exchangeable with the fold models behind the references, so its
                # scores are miscalibrated against them at small n (fresh owner blocks
                # averaged 0.54-0.57 instead of 0.5 at n=40 in simulation).
                bounds = np.cumsum([0] + [len(ix) for _, ix in train_splits])
                self.models[modality].update(
                    fold_fits=fold_fits,
                    fold_matrices=fold_matrices,
                    fold_ref=[
                        np.sort(ensemble_ref[a:b]) for a, b in pairwise(bounds)
                    ],
                )
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
        members = m["raw_ref"].shape[1]
        if m.get("fold_fits"):
            more_anomalous = 0
            for fold_fit, fold_ref, fm in zip(m["fold_fits"], m["fold_ref"], m["fold_matrices"]):
                xk = x.copy()
                if fm is not None:
                    xk[m["columns"].index("wf.markov_ll")] = markov_ll(block.transitions, fm)
                score = rank_scores(fold_fit.raw(xk[None, :])[:, :members], m["raw_ref"])[0]
                more_anomalous += len(fold_ref) - np.searchsorted(fold_ref, score, side="right")
            typicality = (more_anomalous + 0.5) / (len(m["ref"]) + 1)
        else:
            raw = fit.raw(x[None, :])[:, :members]
            score = rank_scores(raw, m["raw_ref"])[0]
            typicality = (
                len(m["ref"]) - np.searchsorted(m["ref"], score, side="right") + 0.5
            ) / (len(m["ref"]) + 1)
        z = fit.zscores(x)
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
            "calibration": (
                "five chronological folds, 60s purged; cross-conformal fold scoring"
                if getattr(self, "calibration", "full") == "cv+"
                else "five chronological folds, 60s purged; OOF references saved"
            ),
            "detector": getattr(self, "detector", "v1"),
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
        # Loading an older artifact must not silently reactivate signals removed from the
        # production identity model.
        for modality in list(obj.models):
            if modality not in ACTIVE_MODALITIES:
                del obj.models[modality]
                obj.disabled[modality] = "Removed from the active identity model"
        return obj
