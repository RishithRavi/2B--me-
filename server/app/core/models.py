"""Per-user identity models (§6 A1 "Enroll and models", §7 B3/B7).

- Artifacts: MODEL_DIR/{user_id}/v{n}/  and  MODEL_DIR/{user_id}/active.json = {"version": n}.
  Active models are loaded from disk at startup — never from the DB.
- Backend: `MODEL_BACKEND=auto|twobme_ml|fallback` (§5.7). `auto` = `twobme_ml.UserModel` (Codex 1)
  when importable, else the server's FallbackUserModel. If twobme_ml refuses a first training job
  (enrollment or purged-calibration gates unmet), that job falls back to FallbackUserModel and the
  version records `backend="fallback"` plus a `metrics.backend_note`, so the identity card can say so.
- Training: `await writer.flush()`, load rows (Tiger, or the parquet `twobme-ml` builds from logs),
  then `await asyncio.to_thread(Backend.train, df, cfg)` — a few hundred rows, a few seconds; no
  process pool (a forked torch process can deadlock).
- Retrain now (§7 B7): `twobme_ml.update.retrain(current, training, anchor_holdout, impostor_holdout,
  candidates, cfg)` for a twobme_ml parent (bounded, guarded, fail-closed); a full refit otherwise.
- Eligibility is row-level (§5.3): impostor / actor-b rows and rows inside takeover marker windows are
  excluded; a session's end reason (e.g. `demo_reset`) never drops its rows.
- A failed train or retrain keeps the previous ready ModelInfo and active model; the failure is only
  reported (`error` on the card + a feed line).
- Versions keep `parent_version`; `activate(version)` rolls back.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import numpy as np
import pandas as pd

from app.core.fallback_model import MIN_BLOCKS as FALLBACK_MIN_BLOCKS
from app.core.fallback_model import FallbackUserModel
from twobme_common.config import load_trust_config
from twobme_common.spec import MODALITIES, load_spec
from twobme_common.types import ModelInfo

log = logging.getLogger("twobme.models")

BACKENDS = ("auto", "twobme_ml", "fallback")
# share of each modality's enrollment blocks (earliest first) protected as anchors in a B7 update
ANCHOR_FRACTION = 0.5
# every Nth fresh genuine monitor block goes to the untouched anchor holdout (never trained on)
HOLDOUT_EVERY = 3


def _twobme_ml_cls() -> Any:
    from twobme_ml import UserModel  # type: ignore[import-not-found]

    return UserModel


def _backend(pref: str | None = None) -> tuple[Any, str]:
    """(class, name) for MODEL_BACKEND. `auto` = twobme_ml if importable, else fallback."""
    if pref is None:
        try:
            from app.config import get_settings

            pref = get_settings().model_backend
        except Exception:
            pref = "auto"
    pref = (pref or "auto").strip().lower()
    if pref == "fallback":
        return FallbackUserModel, "fallback"
    try:
        return _twobme_ml_cls(), "twobme_ml"
    except Exception as e:
        if pref == "twobme_ml":
            log.error("MODEL_BACKEND=twobme_ml but twobme_ml is not importable (%s); using fallback", e)
        return FallbackUserModel, "fallback"


def _artifact_backend(vd: Path, meta: dict) -> str:
    """Which scorer wrote this version (by artifact file, then meta)."""
    if (vd / "fallback_model.json").is_file():
        return "fallback"
    if (vd / "model.joblib").is_file():
        return "twobme_ml"
    return str(meta.get("backend") or "fallback")


class TrainingRefused(Exception):
    pass


# Every desktop row of the user with row-level provenance flags. Eligibility is decided per row
# (`_eligible`), never by the session's end reason: one Reset must not orphan the baseline (§5.3).
# `takeover_excluded`: the block overlaps a takeover_start marker window that ends at the next
# takeover_end / reset marker or the next verified voice/TOTP challenge on that device.
# `tw` is MATERIALIZED and limited to the user's devices: an inlined CTE re-evaluates every window (and its
# two correlated subqueries) per feature row, which passes the pool's 30 s command_timeout after a
# rehearsal night and makes Db mark Tiger down mid-train.
TRAIN_SQL = """
WITH tw AS MATERIALIZED (
  SELECT m.device_id, m.time AS t0,
         least(
           coalesce((SELECT min(m2.time) FROM markers m2
                     WHERE m2.device_id = m.device_id AND m2.time > m.time
                       AND m2.label IN ('takeover_end', 'reset')), 'infinity'::timestamptz),
           coalesce((SELECT min(vc.updated_at) FROM voice_challenges vc
                     WHERE vc.device_id = m.device_id AND vc.updated_at > m.time AND vc.status = 'verified'
                       AND vc.trigger IN ('proactive', 'step_up', 'unlock')), 'infinity'::timestamptz)
         ) AS t1
  FROM markers m
  WHERE m.label = 'takeover_start'
    AND m.device_id IN (SELECT d.id FROM devices d WHERE d.user_id = $1)
)
SELECT fb.time, fb.block_start, fb.session_id, fb.modality, fb.n, fb.features, fb.extras, fb.label, fb.actor,
       fb.schema_version, fb.baseline_eligible, fb.update_candidate, fb.mode,
       coalesce(s.kind, 'normal') AS session_kind,
       EXISTS (SELECT 1 FROM tw WHERE tw.device_id = fb.device_id AND fb.time > tw.t0
                                  AND fb.block_start < tw.t1) AS takeover_excluded
FROM feature_blocks fb
LEFT JOIN sessions s ON s.id = fb.session_id
WHERE fb.user_id = $1
  AND fb.channel = 'desktop'
  AND fb.schema_version = $2
  AND coalesce(s.kind, 'normal') = 'normal'
  AND coalesce(s.ended_reason, '') <> 'purged'
ORDER BY fb.time
"""
TRAIN_COLUMNS = ["time", "block_start", "session_id", "modality", "n", "features", "extras", "label", "actor",
                 "schema_version", "baseline_eligible", "update_candidate", "mode", "session_kind",
                 "takeover_excluded"]


def _flag(df: pd.DataFrame, col: str, default: bool = False) -> pd.Series:
    if col not in df:
        return pd.Series(default, index=df.index, dtype=bool)
    return df[col].astype(object).where(df[col].notna(), default).astype(bool)


def _genuine(df: pd.DataFrame) -> pd.Series:
    """Owner rows: actor a, not labelled impostor, outside every takeover window."""
    actor = df["actor"] if "actor" in df else pd.Series("a", index=df.index)
    label = df["label"] if "label" in df else pd.Series("genuine", index=df.index)
    return actor.fillna("a").ne("b") & label.fillna("genuine").ne("impostor") & ~_flag(df, "takeover_excluded")


def _eligible(df: pd.DataFrame, now: datetime | None = None) -> pd.DataFrame:
    """Row-level training eligibility (full train): genuine AND (enrollment OR matured update candidate)."""
    if df.empty:
        return df
    now = now or datetime.now(UTC)
    times = pd.to_datetime(df["time"], utc=True)
    matured = _flag(df, "update_candidate") & (times < pd.Timestamp(now) - pd.Timedelta(minutes=10))
    mask = _genuine(df) & (_flag(df, "baseline_eligible") | matured)
    return df[mask].sort_values("time").reset_index(drop=True)


def _impostor(df: pd.DataFrame) -> pd.Series:
    actor = df["actor"] if "actor" in df else pd.Series("a", index=df.index)
    label = df["label"] if "label" in df else pd.Series("genuine", index=df.index)
    return actor.fillna("a").eq("b") | label.fillna("genuine").eq("impostor")


def _decline_note(e: Exception, df: pd.DataFrame) -> str:
    """One line for the identity card when twobme_ml refuses a job and the fallback model trains instead."""
    msg = str(e)
    if "enrollment" in msg and "gates" in msg:
        spec = load_spec()
        counts = df.groupby("modality").size().to_dict() if len(df) else {}
        have = {m: int(counts.get(m, 0)) // (6 if m == "temporal" else 1) for m in MODALITIES}
        short = [f"{m} {have[m]}/{spec.modalities[m].enroll_gate}" for m in MODALITIES
                 if have[m] < spec.modalities[m].enroll_gate]
        return f"twobme_ml needs a longer enrollment ({', '.join(short[:3])}); fallback model trained instead"
    return f"twobme_ml declined ({msg[:120]}); fallback model trained instead"


class ModelManager:
    def __init__(self, model_dir: Path, data_dir: Path, db: Any, writer: Any, backend: str | None = None):
        self.model_dir = model_dir
        self.data_dir = data_dir
        self.db = db
        self.writer = writer
        self.backend_cls, self.backend_name = _backend(backend)
        self.active: dict[UUID, Any] = {}           # user_id -> scorer
        self.info: dict[UUID, ModelInfo] = {}       # user_id -> ModelInfo
        self.enrolled_psd: dict[UUID, list[float] | None] = {}
        self.jobs: dict[UUID, asyncio.Task] = {}
        self.on_activated: Callable[[UUID, ModelInfo], Awaitable[None]] | None = None
        self.on_status: Callable[[UUID, ModelInfo], Awaitable[None]] | None = None

    # --- loading ---------------------------------------------------------------------------------
    def user_dir(self, user_id: UUID) -> Path:
        return self.model_dir / str(user_id)

    def load_all(self) -> None:
        if not self.model_dir.is_dir():
            return
        for d in self.model_dir.iterdir():
            try:
                uid = UUID(d.name)
            except ValueError:
                continue
            act = d / "active.json"
            if act.is_file():
                try:
                    v = json.loads(act.read_text())["version"]
                    self._load_version(uid, v)
                except Exception as e:
                    log.error("failed to load active model for %s: %s", uid, e)

    def _load_version(self, user_id: UUID, version: int) -> ModelInfo:
        vd = self.user_dir(user_id) / f"v{version}"
        meta = json.loads((vd / "meta.json").read_text()) if (vd / "meta.json").is_file() else {}
        backend = _artifact_backend(vd, meta)
        cls = FallbackUserModel if backend == "fallback" else _twobme_ml_cls()
        model = cls.load(vd)
        if hasattr(model, "version"):
            try:
                model.version = version
            except Exception:
                pass
        self.active[user_id] = model
        info = self._info_from_meta(meta, version, backend)
        self.info[user_id] = info
        self.enrolled_psd[user_id] = meta.get("enrolled_psd")
        log.info("model v%s active for %s (%s)", version, user_id, backend)
        return info

    @staticmethod
    def _info_from_meta(meta: dict, version: int, backend: str | None = None) -> ModelInfo:
        return ModelInfo(
            status="ready", version=version, trained_at=meta.get("trained_at"),
            n_blocks={k: v for k, v in (meta.get("n_blocks") or {}).items() if k in MODALITIES},
            enabled_modalities=[m for m in meta.get("enabled_modalities", []) if m in MODALITIES],
            metrics=meta.get("metrics") or {}, headline_medians=meta.get("headline_medians") or {},
            learned_since_enroll=int(meta.get("learned_since_enroll", 0)),
            parent_version=meta.get("parent_version"),
            backend=backend or meta.get("backend"),
        )

    def scorer(self, user_id: UUID) -> Any | None:
        return self.active.get(user_id)

    def has_active(self, user_id: UUID) -> bool:
        return self.active.get(user_id) is not None

    def model_info(self, user_id: UUID) -> ModelInfo:
        return self.info.get(user_id) or ModelInfo(status="none", backend=self.backend_name)

    def versions(self, user_id: UUID) -> list[ModelInfo]:
        out = []
        d = self.user_dir(user_id)
        if not d.is_dir():
            return out
        active = self.info.get(user_id)
        for vd in sorted(d.glob("v*"), key=lambda p: int(p.name[1:]) if p.name[1:].isdigit() else 0):
            if not vd.name[1:].isdigit():
                continue
            meta = json.loads((vd / "meta.json").read_text()) if (vd / "meta.json").is_file() else {}
            mi = self._info_from_meta(meta, int(vd.name[1:]), _artifact_backend(vd, meta))
            if active is None or active.version != mi.version:
                mi.status = "none"
            out.append(mi)
        return out

    def next_version(self, user_id: UUID) -> int:
        d = self.user_dir(user_id)
        vs = [int(p.name[1:]) for p in d.glob("v*") if p.name[1:].isdigit()] if d.is_dir() else []
        return max(vs, default=0) + 1

    async def activate(self, user_id: UUID, version: int) -> ModelInfo:
        info = await asyncio.to_thread(self._load_version, user_id, version)
        (self.user_dir(user_id) / "active.json").write_text(json.dumps({"version": version}))
        self.writer.execute("UPDATE models SET is_active = (version = $2) WHERE user_id = $1 AND channel = 'desktop'",
                            user_id, version)
        if self.on_activated:
            await self.on_activated(user_id, info)
        return info

    # --- training --------------------------------------------------------------------------------
    def start_training(self, user_id: UUID, *, source: str, retrain: bool) -> UUID:
        running = self.jobs.get(user_id)
        if running and not running.done():
            raise TrainingRefused("a training job is already running")
        job_id = uuid.uuid4()
        prev = self.info.get(user_id)
        # what the card falls back to if this job fails: the previous READY version, never a blank card
        prev_ready = prev if prev is not None and prev.status == "ready" and self.has_active(user_id) else None
        self.info[user_id] = (prev or ModelInfo(status="none", backend=self.backend_name)).model_copy(
            update={"status": "training", "job_id": job_id, "error": None})
        self.jobs[user_id] = asyncio.create_task(self._train(user_id, job_id, source, retrain, prev_ready))
        return job_id

    async def _load_df(self, user_id: UUID, source: str) -> pd.DataFrame:
        spec = load_spec()
        if source == "logs":
            cands = sorted((self.data_dir / "train").glob("*.parquet"), key=lambda p: p.stat().st_mtime)
            if not cands:
                raise TrainingRefused(f"no parquet in {self.data_dir / 'train'} (run twobme-ml to build it)")
            return pd.read_parquet(cands[-1])
        rows = await self.db.fetch(TRAIN_SQL, user_id, spec.schema_version) if self.db is not None else None
        if rows is None:
            raise TrainingRefused("Tiger is down; train with source=logs")
        return pd.DataFrame([dict(r) for r in rows], columns=TRAIN_COLUMNS)

    async def _train(self, user_id: UUID, job_id: UUID, source: str, retrain: bool,
                     prev_ready: ModelInfo | None = None) -> None:
        try:
            if self.on_status:
                await self.on_status(user_id, self.info[user_id])
            await self.writer.flush()
            df = await self._load_df(user_id, source)
            version = self.next_version(user_id)
            parent = prev_ready.version if prev_ready and prev_ready.version else None
            cfg = load_trust_config()
            current = self.active.get(user_id) if parent else None
            learned: int | None = None
            if (retrain and source == "tiger" and prev_ready is not None and current is not None
                    and self.backend_name == "twobme_ml" and not isinstance(current, FallbackUserModel)):
                # B7: bounded, guarded update of the twobme_ml parent (fail-closed)
                model, train_df, learned = await asyncio.to_thread(self._update, df, cfg, current, prev_ready)
                backend, note, method = "twobme_ml", None, "b7_update"
            else:
                train_df = _eligible(df) if source == "tiger" else df[_genuine(df)]
                if train_df.empty:
                    raise TrainingRefused("no eligible blocks yet")
                model, backend, note = await asyncio.to_thread(self._fit, train_df, cfg, version)
                method = "full_refit" if retrain else "train"
            vd = self.user_dir(user_id) / f"v{version}"
            await asyncio.to_thread(model.save, vd)
            meta = self._augment_meta(vd, train_df, version, parent, backend=backend, note=note, method=method,
                                      learned=learned)
            self.writer.execute(
                """INSERT INTO models (id, user_id, channel, version, schema_version, trained_at, n_blocks, metrics,
                                       headline_medians, artifact_path, is_active, parent_version)
                   VALUES ($1,$2,'desktop',$3,$4,$5,$6,$7,$8,$9,false,$10) ON CONFLICT DO NOTHING""",
                uuid.uuid4(), user_id, version, load_spec().schema_version, datetime.now(UTC),
                meta.get("n_blocks"), meta.get("metrics"), meta.get("headline_medians"), str(vd), parent,
            )
            await self.activate(user_id, version)
            self.info[user_id] = self.info[user_id].model_copy(update={"job_id": job_id})
        except Exception as e:
            if isinstance(e, TrainingRefused | ValueError):
                log.warning("training refused for %s: %s", user_id, e)
            else:
                log.exception("training failed for %s", user_id)
            msg = str(e)[:300] or type(e).__name__
            if prev_ready is not None:
                # keep the previous ready version (and its active scorer); only report the failure
                self.info[user_id] = prev_ready.model_copy(update={"job_id": job_id, "error": msg})
            else:
                self.info[user_id] = ModelInfo(status="failed", job_id=job_id, error=msg, backend=self.backend_name)
            if self.on_status:
                await self.on_status(user_id, self.info[user_id])

    def _fit(self, df: pd.DataFrame, cfg: Any, version: int) -> tuple[Any, str, str | None]:
        """Full training on eligible rows → (model, backend, note). twobme_ml first (when selected); if it
        refuses (enrollment / purged-calibration gates unmet, …) this job falls back to FallbackUserModel."""
        note = None
        if self.backend_cls is not FallbackUserModel:
            try:
                return self.backend_cls.train(df, cfg), "twobme_ml", None
            except Exception as e:
                note = _decline_note(e, df)
                log.warning("twobme_ml training refused (%s); falling back to FallbackUserModel", e)
        model = FallbackUserModel.train(df, cfg, version=version)
        if not model.params:
            counts = {m: int(n) for m, n in df.groupby("modality").size().items()} if len(df) else {}
            raise TrainingRefused(f"need ≥{FALLBACK_MIN_BLOCKS} eligible blocks in at least one modality; "
                                  f"have {counts}")
        return model, "fallback", note

    def _update(self, df: pd.DataFrame, cfg: Any, current: Any, prev: ModelInfo) -> tuple[Any, pd.DataFrame, int]:
        """Assemble the B7 frames from row-level provenance and call `twobme_ml.update.retrain`.

        - training: the parent's population = enrollment blocks + update candidates that had matured
          (≥10 min old) when the parent was trained. `is_anchor` protects the earliest ANCHOR_FRACTION of
          each modality's enrollment blocks (the original enrollment; ≥30% as update.retrain requires).
        - candidates: genuine monitor blocks since the parent; update.retrain keeps only the matured
          `update_candidate` ones and replaces at most 10% of the population.
        - anchor holdout: every HOLDOUT_EVERY-th genuine monitor block since the parent, per modality —
          never in any training set, so the old and new model compare fairly on it.
        - impostor holdout: impostor-labelled / actor-b blocks (marked takeovers).
        """
        from twobme_ml.config import model_config  # type: ignore[import-not-found]
        from twobme_ml.update import retrain  # type: ignore[import-not-found]

        now = pd.Timestamp.now(tz="UTC")
        d = df.copy()
        d["time"] = pd.to_datetime(d["time"], utc=True)
        d["block_start"] = pd.to_datetime(d["block_start"], utc=True)
        for col in ("baseline_eligible", "update_candidate", "takeover_excluded"):
            d[col] = _flag(d, col)
        d["reset_session"] = False  # row-level eligibility: a Reset never orphans the baseline (§5.3)
        d["session_kind"] = d["session_kind"].fillna("normal") if "session_kind" in d else "normal"
        mode = d["mode"].fillna("") if "mode" in d else pd.Series("", index=d.index)
        genuine = _genuine(d)
        t_parent = pd.Timestamp(prev.trained_at) if prev.trained_at else now
        if t_parent.tzinfo is None:
            t_parent = t_parent.tz_localize("UTC")

        enroll = d[genuine & d["baseline_eligible"]]
        is_anchor = pd.Series(False, index=d.index)
        for _m, g in enroll.groupby("modality"):
            g = g.sort_values("time")
            is_anchor.loc[g.index[: max(1, int(np.ceil(len(g) * ANCHOR_FRACTION)))]] = True
        d["is_anchor"] = is_anchor

        mature_at_parent = d["update_candidate"] & (d["time"] < t_parent - pd.Timedelta(minutes=10))
        training = d[genuine & (d["baseline_eligible"] | mature_at_parent)].sort_values("time")
        fresh = d[genuine & ~d["baseline_eligible"] & (d["time"] > t_parent) & mode.eq("monitor")].sort_values("time")
        hold_idx: list[Any] = []
        for _m, g in fresh.groupby("modality"):
            hold_idx.extend(g.index[::HOLDOUT_EVERY])
        anchor_holdout = fresh.loc[hold_idx]
        candidates = fresh.drop(index=hold_idx)
        impostor = d[_impostor(d)]

        # readable refusals first (update.retrain would refuse these too, fail-closed)
        if training.empty:
            raise TrainingRefused("no enrollment blocks to anchor an update")
        if impostor.empty:
            raise TrainingRefused("retrain needs an impostor (B) holdout — run a marked takeover first")
        matured = candidates["update_candidate"] & (candidates["time"] <= now - pd.Timedelta(minutes=10))
        if not matured.any():
            raise TrainingRefused(f"nothing safe to learn yet: no high-confidence genuine blocks ≥10 min old "
                                  f"since v{prev.version}")
        ucfg = model_config(cfg)
        model = retrain(current, training.reset_index(drop=True), anchor_holdout.reset_index(drop=True),
                        impostor.reset_index(drop=True), candidates.reset_index(drop=True), ucfg)
        n_other = int((~training["is_anchor"]).sum())
        replaced = min(int((matured & ~candidates["is_anchor"]).sum()), int(len(training) * 0.1), n_other)
        return model, training, int(prev.learned_since_enroll or 0) + replaced

    def _augment_meta(self, vd: Path, df: pd.DataFrame, version: int, parent: int | None, *,
                      backend: str | None = None, note: str | None = None, method: str | None = None,
                      learned: int | None = None) -> dict:
        """Make sure meta.json carries what ModelInfo needs even if the backend didn't write it."""
        spec = load_spec()
        p = vd / "meta.json"
        meta = json.loads(p.read_text()) if p.is_file() else {}
        meta["backend"] = backend or meta.get("backend") or self.backend_name
        meta["version"] = version
        meta["parent_version"] = parent
        meta.setdefault("trained_at", datetime.now(UTC).isoformat())
        metrics = dict(meta.get("metrics") or {})
        if method:
            metrics["method"] = method
        if note:
            metrics["backend_note"] = note
        if meta.get("detector"):
            metrics.setdefault("detector", meta["detector"])
        meta["metrics"] = metrics
        counts = df.groupby("modality").size().to_dict() if len(df) else {}
        meta.setdefault("n_blocks", {m: int(counts.get(m, 0)) for m in MODALITIES})
        if "enabled_modalities" not in meta:
            meta["enabled_modalities"] = [m for m in MODALITIES if counts.get(m, 0) >= spec.modalities[m].enroll_gate]
        if not meta.get("headline_medians"):
            med: dict[str, float | None] = {}
            for m in MODALITIES:
                rows = df[df["modality"] == m]
                names = spec.names(m)
                for f in spec.modalities[m].features:
                    if not f.headline:
                        continue
                    i = names.index(f.name)
                    vals = [r[i] for r in rows["features"] if r is not None and len(r) > i and r[i] is not None]
                    med[f.column] = float(np.median(vals)) if vals else None
            meta["headline_medians"] = med
        if learned is not None:
            meta["learned_since_enroll"] = int(learned)
        elif "update_candidate" in df:
            meta["learned_since_enroll"] = int(_flag(df, "update_candidate").sum())
        psds = []
        for ex in df.loc[df["modality"] == "temporal", "extras"] if len(df) else []:
            if isinstance(ex, str):
                ex = json.loads(ex)
            if isinstance(ex, dict) and isinstance(ex.get("psd"), list) and len(ex["psd"]) == 32:
                psds.append(ex["psd"])
        meta["enrolled_psd"] = np.mean(np.array(psds, dtype=float), axis=0).round(4).tolist() if psds else None
        p.write_text(json.dumps(meta, indent=2, default=str))
        return meta
