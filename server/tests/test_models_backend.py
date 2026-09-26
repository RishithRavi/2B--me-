"""Identity-model backend (MODEL_BACKEND), train fallback, failed-job semantics, B7 retrain wiring,
row-level training eligibility (§5.3), the secrets startup guard and Db degraded-mode errors."""

from __future__ import annotations

import asyncio
import os
import random
import time
import uuid
from datetime import UTC, datetime, timedelta

import pandas as pd
import pytest
from conftest import ADMIN_TOKEN, login, make_block, register
from test_flows import Agent, setup_monitored

from twobme_common.spec import load_spec

ADMIN = {"X-Admin-Token": ADMIN_TOKEN}

try:
    import twobme_ml  # noqa: F401

    HAVE_ML = True
except Exception:
    HAVE_ML = False


def synth_rows(n: int, *, who: str = "a", start: datetime | None = None, step_s: float = 5.0,
               modalities: tuple[str, ...] = ("keyboard", "mouse"), seed: int = 1, **flags) -> list[dict]:
    spec = load_spec()
    rng = random.Random(seed)
    start = start or datetime.now(UTC) - timedelta(hours=2)
    rows = []
    for i in range(n):
        t = start + timedelta(seconds=step_s * i)
        for m in modalities:
            b = make_block(m, t, who, rng)
            rows.append({
                "time": t, "block_start": t - timedelta(seconds=4), "session_id": flags.get("session_id", "s1"),
                "modality": m, "n": b["n"], "features": spec.vectorize(m, b["features"]), "extras": None,
                "label": "impostor" if who == "b" else "genuine", "actor": who, "schema_version": 1,
                "baseline_eligible": flags.get("baseline_eligible", True),
                "update_candidate": flags.get("update_candidate", False), "mode": flags.get("mode", "enroll"),
                "session_kind": "normal", "takeover_excluded": flags.get("takeover_excluded", False),
            })
    return rows


def wait_job(client, job_id: str, timeout: float = 30.0) -> dict:
    mi: dict = {}
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        mi = client.get("/api/models/active").json()
        if mi.get("job_id") == job_id and mi.get("status") != "training":
            return mi
        time.sleep(0.1)
    raise AssertionError(f"job {job_id} did not finish: {mi}")


# --- 1. backend selection ----------------------------------------------------------------------------------
def test_model_backend_setting(tmp_path, monkeypatch):
    from app.config import get_settings
    from app.core.fallback_model import FallbackUserModel
    from app.core.models import ModelManager

    assert ModelManager(tmp_path, tmp_path, None, None, backend="fallback").backend_cls is FallbackUserModel
    auto = ModelManager(tmp_path, tmp_path, None, None, backend="auto")
    assert auto.backend_name == ("twobme_ml" if HAVE_ML else "fallback")
    monkeypatch.setenv("MODEL_BACKEND", "fallback")
    get_settings.cache_clear()
    try:
        assert ModelManager(tmp_path, tmp_path, None, None).backend_name == "fallback"
    finally:
        get_settings.cache_clear()


def test_artifact_type_decides_loader(tmp_path):
    """A fallback artifact loads as fallback even when twobme_ml is the selected backend (and vice versa)."""
    from app.core.fallback_model import FallbackUserModel
    from app.core.models import ModelManager

    uid = uuid.uuid4()
    df = pd.DataFrame(synth_rows(40))
    m = FallbackUserModel.train(df, version=1)
    vd = tmp_path / str(uid) / "v1"
    m.save(vd)
    (vd / "meta.json").write_text("{}")  # no backend key: detected from the artifact file
    (tmp_path / str(uid) / "active.json").write_text('{"version": 1}')
    mm = ModelManager(tmp_path, tmp_path, None, None, backend="auto")
    mm.load_all()
    assert isinstance(mm.scorer(uid), FallbackUserModel)
    assert mm.model_info(uid).backend == "fallback" and mm.model_info(uid).status == "ready"


# --- 1. training: fallback on twobme_ml refusal, failures keep the previous ready model -------------------------
@pytest.mark.skipif(not HAVE_ML, reason="twobme_ml not installed")
def test_twobme_ml_refusal_falls_back_and_says_so(client, monkeypatch):
    login(client, "a")
    dev_id, _tok = register(client)
    from app.core.runtime import rt

    rows = pd.DataFrame(synth_rows(40))  # 40 blocks: below twobme_ml's enrollment gates, above fallback's 20

    async def fake_load(_uid, _source):
        return rows

    monkeypatch.setattr(rt().models, "_load_df", fake_load)
    assert rt().models.backend_name == "twobme_ml"
    j = client.post("/api/enroll/train", json={"device_id": dev_id, "source": "tiger"})
    assert j.status_code == 200, j.text
    mi = wait_job(client, j.json()["job_id"])
    assert mi["status"] == "ready" and mi["version"] == 1 and mi["backend"] == "fallback", mi
    note = mi["metrics"]["backend_note"]
    assert note.startswith("twobme_ml needs a longer enrollment") and "keyboard 40/100" in note, note
    assert mi["error"] is None
    assert set(mi["enabled_modalities"]) == {"keyboard", "mouse"}


def test_failed_first_train_reports_failed(client, monkeypatch):
    login(client, "a")
    dev_id, _tok = register(client)
    from app.core.runtime import rt

    async def few(_uid, _source):
        return pd.DataFrame(synth_rows(5))

    monkeypatch.setattr(rt().models, "_load_df", few)
    j = client.post("/api/enroll/train", json={"device_id": dev_id, "source": "tiger"})
    mi = wait_job(client, j.json()["job_id"])
    assert mi["status"] == "failed" and "eligible blocks" in mi["error"] and mi["backend"]


def test_failed_retrain_keeps_previous_ready_model(client, monkeypatch):
    uid, dev_id, agent = setup_monitored(client)
    from app.core.models import TrainingRefused
    from app.core.runtime import rt

    mm = rt().models
    scorer_before = mm.scorer(uuid.UUID(uid))

    async def refuse(_uid, _source):
        raise TrainingRefused("synthetic refusal")

    monkeypatch.setattr(mm, "_load_df", refuse)
    j = client.post("/api/models/retrain", json={"device_id": dev_id})
    assert j.status_code == 200, j.text
    mi = wait_job(client, j.json()["job_id"])
    assert mi["status"] == "ready" and mi["version"] == 1 and "synthetic refusal" in mi["error"], mi
    assert mm.scorer(uuid.UUID(uid)) is scorer_before  # identity card and scorer untouched
    feed = rt().hub.devices[uuid.UUID(dev_id)].feed
    assert any("Retrain refused" in f.text and "v1 kept" in f.text for f in feed)
    assert agent.tick("a")["level"] != "learning"  # still monitoring with v1
    agent.close()


def test_successful_refit_clears_error_and_bumps_version(client, monkeypatch):
    uid, dev_id, agent = setup_monitored(client)
    from app.core.runtime import rt

    rows = pd.DataFrame(synth_rows(60, seed=4))

    async def ok(_uid, _source):
        return rows

    monkeypatch.setattr(rt().models, "_load_df", ok)
    # the fallback parent → full refit (twobme_ml declines 60 blocks → fallback), parent kept for rollback
    mi = wait_job(client, client.post("/api/models/retrain", json={"device_id": dev_id}).json()["job_id"])
    assert mi["status"] == "ready" and mi["version"] == 2 and mi["parent_version"] == 1 and mi["error"] is None
    assert mi["metrics"]["method"] == "full_refit"
    agent.close()


def test_retrain_uses_b7_update_for_a_twobme_ml_parent(tmp_path, monkeypatch):
    """Retrain now → `_update` (twobme_ml.update.retrain) when the parent is a twobme_ml model."""
    from app.core.fallback_model import FallbackUserModel
    from app.core.models import ModelManager
    from twobme_common.types import ModelInfo

    class W:
        async def flush(self):
            return 0

        def execute(self, *a):
            pass

    mm = ModelManager(tmp_path, tmp_path, None, W(), backend="auto")
    mm.backend_name = "twobme_ml"
    uid = uuid.uuid4()
    rows = pd.DataFrame(synth_rows(40))
    trained = FallbackUserModel.train(rows, version=2)
    seen = {}

    class Parent:  # stands in for a twobme_ml UserModel
        version = 1

    def fake_update(df, cfg, current, prev):
        seen.update(current=current, prev=prev)
        return trained, rows, 7

    async def fake_load(_u, _s):
        return rows

    mm._update = fake_update
    mm._load_df = fake_load
    mm.active[uid] = Parent()
    prev = ModelInfo(status="ready", version=1, trained_at=datetime.now(UTC), learned_since_enroll=3)
    mm.info[uid] = prev
    (tmp_path / str(uid) / "v1").mkdir(parents=True)

    async def go():
        job = mm.start_training(uid, source="tiger", retrain=True)
        await mm.jobs[uid]
        return job

    job = asyncio.run(go())
    info = mm.model_info(uid)
    assert isinstance(seen["current"], Parent) and seen["prev"].version == 1
    assert info.status == "ready" and info.version == 2 and info.job_id == job
    assert info.learned_since_enroll == 7 and info.metrics["method"] == "b7_update"


def _update_frames(monkeypatch, df: pd.DataFrame, trained_at: datetime) -> dict:
    import twobme_ml.update as upd

    from app.core.models import ModelManager
    from twobme_common.config import load_trust_config
    from twobme_common.types import ModelInfo

    captured = {}

    def fake_retrain(current, training, anchor_holdout, impostor_holdout, candidates, cfg):
        captured.update(training=training, anchor=anchor_holdout, impostor=impostor_holdout,
                        candidates=candidates, cfg=cfg)
        return "NEW"

    monkeypatch.setattr(upd, "retrain", fake_retrain)
    mm = ModelManager(None, None, None, None, backend="auto")
    prev = ModelInfo(status="ready", version=1, trained_at=trained_at, learned_since_enroll=0)
    model, _training, learned = mm._update(df, load_trust_config(), object(), prev)
    assert model == "NEW"
    captured["learned"] = learned
    return captured


@pytest.mark.skipif(not HAVE_ML, reason="twobme_ml not installed")
def test_b7_frames_are_row_level_and_leak_free(monkeypatch):
    now = datetime.now(UTC)
    enroll = synth_rows(40, start=now - timedelta(hours=2), session_id="enroll")
    trained_at = now - timedelta(hours=1, minutes=50)
    fresh = synth_rows(30, start=now - timedelta(minutes=45), session_id="after-reset", baseline_eligible=False,
                       update_candidate=True, mode="monitor", seed=2)
    takeover = synth_rows(6, start=now - timedelta(minutes=30), session_id="after-reset", baseline_eligible=False,
                          update_candidate=True, mode="monitor", takeover_excluded=True, seed=3)
    impostor = synth_rows(10, who="b", start=now - timedelta(minutes=29), session_id="after-reset",
                          baseline_eligible=False, mode="monitor", seed=4)
    df = pd.DataFrame(enroll + fresh + takeover + impostor)
    got = _update_frames(monkeypatch, df, trained_at)
    tr, ah, ih, ca = got["training"], got["anchor"], got["impostor"], got["candidates"]
    assert set(tr.session_id) == {"enroll"} and tr.baseline_eligible.all()
    assert tr.is_anchor.mean() >= 0.3 and not tr.is_anchor.all()  # protected core + replaceable rest
    assert set(ih.actor) == {"b"} and len(ih) == len(impostor)
    for frame in (tr, ah, ca):
        assert not frame.takeover_excluded.any() and frame.actor.eq("a").all()
    keys = lambda f: set(zip(f.session_id, f.modality, f.time.astype(str), strict=True))  # noqa: E731
    assert not keys(ah) & keys(ca) and not keys(ah) & keys(tr)  # the anchor holdout is untouched
    assert len(ah) + len(ca) == len(fresh)
    assert not ca.reset_session.any()  # a Reset never orphans rows (§5.3)
    assert {"update_candidate", "takeover_excluded", "reset_session", "session_kind", "label", "actor", "time",
            "baseline_eligible", "is_anchor"} <= set(ca.columns)
    assert "spec" in got["cfg"] and got["learned"] > 0


@pytest.mark.skipif(not HAVE_ML, reason="twobme_ml not installed")
def test_b7_refuses_readably_without_impostor_holdout(monkeypatch):
    from app.core.models import TrainingRefused

    now = datetime.now(UTC)
    df = pd.DataFrame(synth_rows(40, start=now - timedelta(hours=2))
                      + synth_rows(20, start=now - timedelta(minutes=40), baseline_eligible=False,
                                   update_candidate=True, mode="monitor", seed=2))
    with pytest.raises(TrainingRefused, match="impostor"):
        _update_frames(monkeypatch, df, now - timedelta(hours=1, minutes=50))


# --- 5e. row-level training eligibility ----------------------------------------------------------------------
def test_training_eligibility_is_row_level():
    from app.core.models import TRAIN_SQL, _eligible

    now = datetime.now(UTC)
    base = synth_rows(10, start=now - timedelta(hours=1), session_id="reset-session")  # ended by demo_reset
    cands_old = synth_rows(4, start=now - timedelta(minutes=40), baseline_eligible=False, update_candidate=True,
                           mode="monitor", seed=2)
    cands_new = synth_rows(4, start=now - timedelta(minutes=3), baseline_eligible=False, update_candidate=True,
                           mode="monitor", seed=3)
    imp = synth_rows(4, who="b", start=now - timedelta(minutes=30), seed=4)
    window = synth_rows(4, start=now - timedelta(minutes=20), takeover_excluded=True, seed=5)
    df = pd.DataFrame(base + cands_old + cands_new + imp + window)
    el = _eligible(df)
    assert len(el) == 2 * (10 + 4)  # enrollment (incl. the reset session) + matured candidates
    assert set(el.actor) == {"a"} and not el.takeover_excluded.any()
    assert "demo_reset" not in TRAIN_SQL and "takeover_excluded" in TRAIN_SQL


@pytest.mark.skipif(not os.environ.get("TEST_TIGER_URL"), reason="needs TEST_TIGER_URL")
def test_train_sql_row_level_against_tiger(client):
    """Reset no longer orphans the baseline; takeover-window rows are excluded even if labelled genuine."""
    import json

    from conftest import make_tick

    from app.core.models import TRAIN_SQL, _eligible
    from app.core.runtime import rt

    me = login(client, "a")
    dev_id, token = register(client)
    agent = Agent(client, token, mode="enroll")
    drt = rt().hub.devices[uuid.UUID(dev_id)]
    rng = random.Random(11)
    t0 = datetime.now(UTC)

    def tick(offset_s: float) -> None:  # 0.2 s blocks, 1 s apart, all inside the 30 s skew window
        t_end = t0 + timedelta(seconds=offset_s)
        raw = json.loads(make_tick(agent.run_id, agent.seq, "a", rng, t_end=t_end, session_id=str(drt.session_id)))
        for b in raw["blocks"]:
            b["t_start"] = (t_end - timedelta(seconds=0.2)).isoformat()
        agent.seq += 1
        agent.ws.send_text(json.dumps(raw))
        while True:
            m = agent.ws.receive_json()
            if m["type"] == "trust" and m.get("seq") == raw["seq"]:
                return

    def marker(label: str, offset_s: float) -> None:
        agent.ws.send_text(json.dumps({"type": "marker", "label": label,
                                       "t": (t0 + timedelta(seconds=offset_s)).isoformat()}))

    for k in range(6):
        tick(-24 + k)                                     # enrollment in session 1 …
    assert client.post("/api/demo/reset", json={"device_id": dev_id}, headers=ADMIN).status_code == 200
    for k in range(4):
        tick(-17 + k)                                     # … which a Reset ends (demo_reset)
    marker("takeover_start", -11.5)
    tick(-11.4)  # let the marker land before re-labelling
    client.post("/api/demo/label", json={"device_id": dev_id, "label": "genuine", "actor": "a"})  # mislabelled
    tick(-10)
    tick(-9)
    marker("takeover_end", -8.5)
    tick(-7)
    tick(-6)
    client.portal.call(rt().writer.flush)
    rows = client.portal.call(rt().db.fetch, TRAIN_SQL, uuid.UUID(me["user_id"]), 1)
    mine = client.portal.call(rt().db.fetch, "SELECT id FROM sessions WHERE device_id = $1", uuid.UUID(dev_id))
    df = pd.DataFrame([dict(r) for r in rows])
    df = df[df.session_id.isin({r["id"] for r in mine})]  # the DB may hold other tests' rows for a@
    assert len(df) == 15 * 2
    assert int(df.takeover_excluded.sum()) == 3 * 2       # the three ticks inside the window
    el = _eligible(df)
    assert len(el) == 12 * 2                              # 6 before + 4 after the Reset + 2 after takeover_end
    assert el.time.min() == df.time.min()                 # the reset session's rows are still there
    agent.close()


# --- 5f. secrets startup guard ---------------------------------------------------------------------------------
def _app_env(monkeypatch, tmp_path, **over):
    env = {"TIGER_DATABASE_URL": "", "DATA_DIR": str(tmp_path / "data"), "REPORTS_DIR": str(tmp_path / "r"),
           "DEMO_MODE": "true", "COOKIE_SECURE": "true", "SESSION_SECRET": "s" * 48, "ADMIN_TOKEN": "t" * 32,
           "SEED_PASSWORD_A": "pa-" + "x" * 12, "SEED_PASSWORD_B": "pb-" + "x" * 12,
           "SEED_PASSWORD_ADMIN": "pad-" + "x" * 12, "VOICE_MODE": "stub"}
    env.update(over)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    from app.config import get_settings

    get_settings.cache_clear()


@pytest.mark.parametrize("over", [
    {"ADMIN_TOKEN": "change-me"},
    {"SESSION_SECRET": "change-me-64-random-bytes"},
    {"SEED_PASSWORD_A": ""},
    {"SEED_PASSWORD_ADMIN": "admin-dev-password"},
])
def test_startup_refuses_public_secrets_with_secure_cookies(tmp_path, monkeypatch, over):
    from fastapi.testclient import TestClient

    from app.config import get_settings
    from app.main import create_app

    _app_env(monkeypatch, tmp_path, **over)
    try:
        with pytest.raises(RuntimeError, match=next(iter(over))), TestClient(create_app()):
            pass
    finally:
        get_settings.cache_clear()


def test_startup_allows_real_secrets_or_insecure_dev(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import get_settings, insecure_secrets
    from app.main import create_app

    _app_env(monkeypatch, tmp_path)
    try:
        with TestClient(create_app()) as c:
            assert c.get("/api/status").status_code == 200
        _app_env(monkeypatch, tmp_path, COOKIE_SECURE="false", ADMIN_TOKEN="change-me")
        assert insecure_secrets(get_settings()) == []
    finally:
        get_settings.cache_clear()


# --- 7. Db: connect-time Postgres errors are "db down" --------------------------------------------------------
@pytest.mark.parametrize("exc_name", ["CannotConnectNowError", "TooManyConnectionsError",
                                      "ObjectNotInPrerequisiteStateError"])
def test_db_connect_time_errors_degrade(exc_name):
    import asyncpg

    from app.db.pool import Db

    exc = getattr(asyncpg.exceptions, exc_name)

    class Pool:
        async def fetch(self, *a):
            raise exc("the database system is starting up")

        async def execute(self, *a):
            raise exc("too many clients")

        def terminate(self):
            pass

    db = Db("postgres://example/none")
    db.pool = Pool()
    assert asyncio.run(db.fetch("SELECT 1")) is None and not db.up
    db.pool = Pool()
    assert asyncio.run(db.execute("SELECT 1")) is False and not db.up


def test_agent_hello_survives_db_errors(client):
    """agent_hello → enroll counts → Db.fetch must never raise into the WS handshake."""
    import asyncpg

    login(client, "a")
    _dev, token = register(client)
    from app.core.runtime import rt

    class Pool:
        async def fetch(self, *a):
            raise asyncpg.exceptions.CannotConnectNowError("the database system is starting up")

        def terminate(self):
            pass

    rt().db.pool = Pool()
    agent = Agent(client, token)
    assert agent.welcome["type"] == "welcome" and not rt().db.up
    assert agent.tick("a")["type"] == "trust"
    agent.close()
