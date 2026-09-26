"""repo_voice: profiles survive a restart without Tiger via the .npz mirror; challenges are memory-first."""

from __future__ import annotations

import asyncio
import uuid

import numpy as np

from app.db.repo_voice import RepoVoice


class _Db:
    async def fetchrow(self, *a, **k):
        return None


class _Writer:
    def __init__(self):
        self.stmts, self.rows = [], []

    def execute(self, sql, *args):
        self.stmts.append(sql)

    def insert(self, table, row):
        self.rows.append((table, row))


def test_profile_mirror_roundtrip(tmp_path):
    async def run():
        w = _Writer()
        repo = RepoVoice(_Db(), w, tmp_path)
        uid = uuid.uuid4()
        emb = np.random.default_rng(0).normal(size=192)
        await repo.insert_profile(user_id=uid, speaker_embedding=emb, utt_embeddings=[emb, emb], spectral_summary=np.ones(64),
                                  n_utts=2, intra_cos=0.7)
        await repo.insert_profile(user_id=uid, speaker_embedding=emb, utt_embeddings=[emb], spectral_summary=np.ones(64),
                                  n_utts=1, intra_cos=None, label="expo", mfcc_mean=np.arange(20))
        assert len(w.stmts) == 2
        fresh = RepoVoice(_Db(), _Writer(), tmp_path)
        assert fresh.load_mirror() == 2
        profs = await fresh.get_profiles(uid)
        assert {p["label"] for p in profs} == {"quiet", "expo"}
        quiet = await fresh.get_active_profile(uid)
        assert quiet["label"] == "quiet" and quiet["mfcc_mean"] is None and quiet["intra_cos"] == 0.7
        expo = next(p for p in profs if p["label"] == "expo")
        assert expo["mfcc_mean"].shape == (20,) and expo["intra_cos"] is None
        assert np.allclose(quiet["speaker_embedding"], emb.astype(np.float32))

    asyncio.run(run())


def test_challenge_memory_first(tmp_path):
    async def run():
        w = _Writer()
        repo = RepoVoice(_Db(), w, tmp_path)
        cid, dev = uuid.uuid4(), uuid.uuid4()
        await repo.insert_challenge({"id": cid, "user_id": uuid.uuid4(), "device_id": dev, "trigger": "proactive",
                                     "status": "issued", "phrase": "a b c d e"})
        assert repo.open_for_device(dev)[0]["id"] == cid
        await repo.update_challenge(cid, status="verified")
        assert repo.open_for_device(dev) == []
        assert (await repo.get_challenge(cid))["status"] == "verified"
        try:
            await repo.update_challenge(cid, audio_blob=b"x")
        except KeyError:
            pass
        else:
            raise AssertionError("unknown columns must be rejected")

    asyncio.run(run())
