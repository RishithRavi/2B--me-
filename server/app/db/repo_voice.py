"""Voice persistence interface for server/app/voice (Codex 2). Owner: Claude. §5.6.

    from app.db import repo_voice
    pid = await repo_voice.insert_profile(user_id=..., speaker_embedding=..., utt_embeddings=[...],
                                          spectral_summary=..., n_utts=5, intra_cos=0.71, label="quiet")
    prof = await repo_voice.get_active_profile(user_id)          # newest 'quiet' profile (dict) or None
    profs = await repo_voice.get_profiles(user_id)               # all labels, newest first (quiet + expo)
    await repo_voice.insert_challenge(row)                       # row keys = voice_challenges columns
    await repo_voice.update_challenge(challenge_id, status="scoring", attempt=2, ...)
    row = await repo_voice.get_challenge(challenge_id)           # dict or None

Memory is authoritative (degraded mode): challenges live in an in-process cache and are written
through to Tiger via the batch writer; profiles are mirrored to data/voice_profiles/*.npz and loaded
at startup, so voice keeps working when Tiger is down. Audio is never stored here.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import numpy as np

from app.db.writer import COLUMNS
from twobme_common.types import utcnow

log = logging.getLogger("twobme.repo_voice")

TERMINAL = {"verified", "blocked_spoof", "blocked_impostor", "expired", "cancelled"}
_CH_COLS = set(COLUMNS["voice_challenges"])


class RepoVoice:
    def __init__(self, db: Any, writer: Any, profiles_dir: Path):
        self.db = db
        self.writer = writer
        self.profiles_dir = profiles_dir
        self.challenges: dict[UUID, dict[str, Any]] = {}
        self.profiles: dict[UUID, list[dict[str, Any]]] = {}

    # --- profiles ------------------------------------------------------------------------------
    async def insert_profile(self, *, user_id: UUID, speaker_embedding: Any, utt_embeddings: Any,
                             spectral_summary: Any, n_utts: int, intra_cos: float | None,
                             label: str = "quiet") -> UUID:
        pid = uuid.uuid4()
        prof = {
            "id": pid, "user_id": user_id, "label": label,
            "speaker_embedding": np.asarray(speaker_embedding, dtype=np.float32),
            "utt_embeddings": [list(map(float, u)) for u in (utt_embeddings or [])],
            "spectral_summary": np.asarray(spectral_summary, dtype=np.float32),
            "n_utts": int(n_utts), "intra_cos": None if intra_cos is None else float(intra_cos),
            "created_at": utcnow(),
        }
        self.profiles.setdefault(user_id, []).insert(0, prof)
        self._mirror(prof)
        self.writer.execute(
            """INSERT INTO voice_profiles (id, user_id, label, speaker_embedding, utt_embeddings, spectral_summary,
                                           n_utts, intra_cos, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING""",
            pid, user_id, label, prof["speaker_embedding"], prof["utt_embeddings"], prof["spectral_summary"],
            prof["n_utts"], prof["intra_cos"], prof["created_at"],
        )
        return pid

    async def get_profiles(self, user_id: UUID) -> list[dict[str, Any]]:
        return list(self.profiles.get(user_id, []))

    async def get_active_profile(self, user_id: UUID) -> dict[str, Any] | None:
        profs = self.profiles.get(user_id, [])
        quiet = [p for p in profs if p["label"] == "quiet"]
        return (quiet or profs or [None])[0]

    def _mirror(self, prof: dict[str, Any]) -> None:
        try:
            self.profiles_dir.mkdir(parents=True, exist_ok=True)
            np.savez(
                self.profiles_dir / f"{prof['user_id']}_{prof['id']}.npz",
                id=str(prof["id"]), user_id=str(prof["user_id"]), label=prof["label"],
                speaker_embedding=prof["speaker_embedding"],
                utt_embeddings=np.asarray(prof["utt_embeddings"], dtype=np.float32),
                spectral_summary=prof["spectral_summary"], n_utts=prof["n_utts"],
                intra_cos=np.nan if prof["intra_cos"] is None else prof["intra_cos"],
                created_at=prof["created_at"].isoformat(),
            )
        except Exception as e:
            log.error("voice profile mirror failed: %s", e)

    def load_mirror(self) -> int:
        n = 0
        if not self.profiles_dir.is_dir():
            return 0
        for f in sorted(self.profiles_dir.glob("*.npz")):
            try:
                z = np.load(f, allow_pickle=False)
                ic = float(z["intra_cos"])
                prof = {
                    "id": UUID(str(z["id"])), "user_id": UUID(str(z["user_id"])), "label": str(z["label"]),
                    "speaker_embedding": z["speaker_embedding"], "utt_embeddings": z["utt_embeddings"].tolist(),
                    "spectral_summary": z["spectral_summary"], "n_utts": int(z["n_utts"]),
                    "intra_cos": None if np.isnan(ic) else ic,
                    "created_at": datetime.fromisoformat(str(z["created_at"])),
                }
                self.profiles.setdefault(prof["user_id"], []).append(prof)
                n += 1
            except Exception as e:
                log.error("bad voice profile mirror %s: %s", f, e)
        for lst in self.profiles.values():
            lst.sort(key=lambda p: p["created_at"], reverse=True)
        return n

    # --- challenges ------------------------------------------------------------------------------
    async def insert_challenge(self, row: dict[str, Any]) -> None:
        unknown = set(row) - _CH_COLS
        if unknown:
            raise KeyError(f"voice_challenges: unknown columns {sorted(unknown)}")
        r = {c: row.get(c) for c in COLUMNS["voice_challenges"]}
        r["id"] = r["id"] or uuid.uuid4()
        r["attempt"] = r["attempt"] or 1
        r["issued_at"] = r["issued_at"] or utcnow()
        self.challenges[r["id"]] = r
        self.writer.insert("voice_challenges", r)

    async def update_challenge(self, challenge_id: UUID, **fields: Any) -> None:
        unknown = set(fields) - _CH_COLS
        if unknown:
            raise KeyError(f"voice_challenges: unknown columns {sorted(unknown)}")
        r = self.challenges.get(challenge_id)
        if r is None:
            r = await self._load(challenge_id)
        if r is not None:
            r.update(fields)
        if fields:
            cols = list(fields)
            sets = ", ".join(f"{c} = ${i + 2}" for i, c in enumerate(cols))
            self.writer.execute(
                f"UPDATE voice_challenges SET {sets}, updated_at = now() WHERE id = $1",
                challenge_id, *[fields[c] for c in cols],
            )

    async def get_challenge(self, challenge_id: UUID) -> dict[str, Any] | None:
        r = self.challenges.get(challenge_id)
        if r is None:
            r = await self._load(challenge_id)
        return dict(r) if r else None

    async def _load(self, challenge_id: UUID) -> dict[str, Any] | None:
        row = await self.db.fetchrow("SELECT * FROM voice_challenges WHERE id = $1", challenge_id)
        if row is None:
            return None
        r = {c: row[c] for c in COLUMNS["voice_challenges"]}
        self.challenges[challenge_id] = r
        return r

    def open_for_device(self, device_id: UUID, now: datetime | None = None) -> list[dict[str, Any]]:
        now = now or utcnow()
        return sorted(
            (dict(r) for r in self.challenges.values()
             if r.get("device_id") == device_id and r.get("status") not in TERMINAL
             and r.get("trigger") in ("proactive", "step_up", "unlock")),
            key=lambda r: r["issued_at"], reverse=True,
        )


# --- module-level API (what server/app/voice imports) ----------------------------------------------
def _repo() -> RepoVoice:
    from app.core.runtime import rt

    return rt().repo_voice


async def insert_profile(**kw: Any) -> UUID:
    return await _repo().insert_profile(**kw)


async def get_active_profile(user_id: UUID) -> dict[str, Any] | None:
    return await _repo().get_active_profile(user_id)


async def get_profiles(user_id: UUID) -> list[dict[str, Any]]:
    return await _repo().get_profiles(user_id)


async def insert_challenge(row: dict[str, Any]) -> None:
    await _repo().insert_challenge(row)


async def update_challenge(challenge_id: UUID, **fields: Any) -> None:
    await _repo().update_challenge(challenge_id, **fields)


async def get_challenge(challenge_id: UUID) -> dict[str, Any] | None:
    return await _repo().get_challenge(challenge_id)
