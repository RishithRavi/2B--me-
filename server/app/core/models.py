"""Per-user identity models (§6 A1 "Enroll and models", §7 B3/B7).

- Artifacts: MODEL_DIR/{user_id}/v{n}/  and  MODEL_DIR/{user_id}/active.json = {"version": n}.
  Active models are loaded from disk at startup — never from the DB.
- Backend: `twobme_ml.UserModel` (Codex 1) when importable, else the server's FallbackUserModel.
- Training: `await writer.flush()`, load rows (Tiger, or the parquet `twobme-ml` builds from logs),
  then `await asyncio.to_thread(Backend.train, df, cfg)` — a few hundred rows, a few seconds; no
  process pool (a forked torch process can deadlock).
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

from app.core.fallback_model import FallbackUserModel
from twobme_common.config import load_trust_config
from twobme_common.spec import MODALITIES, load_spec
from twobme_common.types import ModelInfo

log = logging.getLogger("twobme.models")


def _backend() -> tuple[Any, str]:
    try:
        from twobme_ml import UserModel  # type: ignore[import-not-found]

        return UserModel, "twobme_ml"
    except Exception:
        return FallbackUserModel, "fallback"


class TrainingRefused(Exception):
    pass


TRAIN_SQL = """
SELECT fb.time, fb.block_start, fb.session_id, fb.modality, fb.n, fb.features, fb.extras, fb.label, fb.actor,
       fb.schema_version, fb.baseline_eligible, fb.update_candidate
FROM feature_blocks fb
LEFT JOIN sessions s ON s.id = fb.session_id
WHERE fb.user_id = $1
  AND fb.channel = 'desktop'
  AND fb.schema_version = $2
  AND fb.actor IS DISTINCT FROM 'b'
  AND fb.label IS DISTINCT FROM 'impostor'
  AND (fb.baseline_eligible OR (fb.update_candidate AND fb.time < now() - INTERVAL '10 minutes'))
  AND coalesce(s.kind, 'normal') = 'normal'
  AND coalesce(s.ended_reason, '') NOT IN ('demo_reset', 'purged')
ORDER BY fb.time
"""


class ModelManager:
    def __init__(self, model_dir: Path, data_dir: Path, db: Any, writer: Any):
        self.model_dir = model_dir
        self.data_dir = data_dir
        self.db = db
        self.writer = writer
        self.backend_cls, self.backend_name = _backend()
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
        backend = meta.get("backend", self.backend_name)
        cls = FallbackUserModel if backend == "fallback" else self.backend_cls
        model = cls.load(vd)
        if hasattr(model, "version"):
            try:
                model.version = version
            except Exception:
                pass
        self.active[user_id] = model
        info = self._info_from_meta(meta, version)
        self.info[user_id] = info
        self.enrolled_psd[user_id] = meta.get("enrolled_psd")
        log.info("model v%s active for %s (%s)", version, user_id, backend)
        return info

    @staticmethod
    def _info_from_meta(meta: dict, version: int) -> ModelInfo:
        return ModelInfo(
            status="ready", version=version, trained_at=meta.get("trained_at"),
            n_blocks={k: v for k, v in (meta.get("n_blocks") or {}).items() if k in MODALITIES},
            enabled_modalities=[m for m in meta.get("enabled_modalities", []) if m in MODALITIES],
            metrics=meta.get("metrics") or {}, headline_medians=meta.get("headline_medians") or {},
            learned_since_enroll=int(meta.get("learned_since_enroll", 0)),
            parent_version=meta.get("parent_version"),
        )

    def scorer(self, user_id: UUID) -> Any | None:
        return self.active.get(user_id)

    def model_info(self, user_id: UUID) -> ModelInfo:
        return self.info.get(user_id) or ModelInfo(status="none")

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
            mi = self._info_from_meta(meta, int(vd.name[1:]))
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
        self.info[user_id] = (prev or ModelInfo(status="none")).model_copy(
            update={"status": "training", "job_id": job_id, "error": None})
        self.jobs[user_id] = asyncio.create_task(self._train(user_id, job_id, source, retrain))
        return job_id

    async def _load_df(self, user_id: UUID, source: str) -> pd.DataFrame:
        spec = load_spec()
        if source == "logs":
            cands = sorted((self.data_dir / "train").glob("*.parquet"), key=lambda p: p.stat().st_mtime)
            if not cands:
                raise TrainingRefused(f"no parquet in {self.data_dir / 'train'} (run twobme-ml to build it)")
            return pd.read_parquet(cands[-1])
        rows = await self.db.fetch(TRAIN_SQL, user_id, spec.schema_version)
        if rows is None:
            raise TrainingRefused("Tiger is down; train with source=logs")
        return pd.DataFrame([dict(r) for r in rows], columns=[
            "time", "block_start", "session_id", "modality", "n", "features", "extras", "label", "actor",
            "schema_version", "baseline_eligible", "update_candidate"])

    async def _train(self, user_id: UUID, job_id: UUID, source: str, retrain: bool) -> None:
        prev = self.info.get(user_id)
        try:
            if self.on_status:
                await self.on_status(user_id, self.info[user_id])
            await self.writer.flush()
            df = await self._load_df(user_id, source)
            if df.empty:
                raise TrainingRefused("no eligible blocks yet")
            version = self.next_version(user_id)
            parent = prev.version if prev and prev.version else None
            cfg = load_trust_config()
            parent_dir = self.user_dir(user_id) / f"v{parent}" if parent else None
            model = await asyncio.to_thread(self._fit, df, cfg, version, retrain, parent_dir)
            vd = self.user_dir(user_id) / f"v{version}"
            await asyncio.to_thread(model.save, vd)
            meta = self._augment_meta(vd, df, version, parent)
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
            log.exception("training failed for %s", user_id)
            base = prev if prev and prev.status == "ready" else ModelInfo(status="failed")
            self.info[user_id] = base.model_copy(update={"job_id": job_id, "error": str(e)[:300],
                                                         "status": base.status if prev and prev.status == "ready" else "failed"})
            if self.on_status:
                await self.on_status(user_id, self.info[user_id])

    def _fit(self, df: pd.DataFrame, cfg: Any, version: int, retrain: bool, parent_dir: Path | None) -> Any:
        cls = self.backend_cls
        if cls is FallbackUserModel:
            return FallbackUserModel.train(df, cfg, version=version)
        if retrain and parent_dir is not None and hasattr(cls, "retrain"):
            # B7: twobme_ml decides anchor share / quarantine / rejection
            return cls.retrain(cls.load(parent_dir), df, cfg)
        return cls.train(df, cfg)

    def _augment_meta(self, vd: Path, df: pd.DataFrame, version: int, parent: int | None) -> dict:
        """Make sure meta.json carries what ModelInfo needs even if the backend didn't write it."""
        spec = load_spec()
        p = vd / "meta.json"
        meta = json.loads(p.read_text()) if p.is_file() else {}
        meta.setdefault("backend", self.backend_name)
        meta["version"] = version
        meta["parent_version"] = parent
        meta.setdefault("trained_at", datetime.now(UTC).isoformat())
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
        if "update_candidate" in df:
            meta["learned_since_enroll"] = int(df["update_candidate"].fillna(False).astype(bool).sum())
        psds = []
        for ex in df.loc[df["modality"] == "temporal", "extras"] if len(df) else []:
            if isinstance(ex, str):
                ex = json.loads(ex)
            if isinstance(ex, dict) and isinstance(ex.get("psd"), list) and len(ex["psd"]) == 32:
                psds.append(ex["psd"])
        meta["enrolled_psd"] = np.mean(np.array(psds, dtype=float), axis=0).round(4).tolist() if psds else None
        p.write_text(json.dumps(meta, indent=2, default=str))
        return meta
