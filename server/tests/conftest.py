"""Server test harness. Runs in degraded mode (no Tiger) unless TEST_TIGER_URL is set."""

from __future__ import annotations

import json
import os
import random
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from twobme_common.spec import load_spec  # noqa: E402

ADMIN_TOKEN = "test-admin-token"
PW = {"a": "pw-a", "b": "pw-b", "admin": "pw-admin"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("TIGER_DATABASE_URL", os.environ.get("TEST_TIGER_URL", ""))
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("REPORTS_DIR", str(tmp_path / "reports"))
    monkeypatch.setenv("COOKIE_SECURE", "false")
    monkeypatch.setenv("DEMO_MODE", "true")
    monkeypatch.setenv("ADMIN_TOKEN", ADMIN_TOKEN)
    monkeypatch.setenv("SEED_PASSWORD_A", PW["a"])
    monkeypatch.setenv("SEED_PASSWORD_B", PW["b"])
    monkeypatch.setenv("SEED_PASSWORD_ADMIN", PW["admin"])
    monkeypatch.setenv("DECISION_TICK_WAIT_S", "0.05")
    monkeypatch.setenv("DB_CONNECT_TIMEOUT_S", "2")
    from app.config import get_settings

    get_settings.cache_clear()
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app()) as c:
        c.agents = []  # fake agents opened by tests; closed here so a failing test can't hang teardown
        try:
            yield c
        finally:
            for a in c.agents:
                try:
                    a.close()
                except Exception:
                    pass
    get_settings.cache_clear()


def login(c, who: str = "a"):
    email = {"a": "a@2bme.tech", "b": "b@2bme.tech", "admin": "admin@2bme.tech"}[who]
    r = c.post("/api/auth/login", json={"email": email, "password": PW[who]})
    assert r.status_code == 200, r.text
    return r.json()


def register(c) -> tuple[str, str]:
    r = c.post("/api/devices/register", json={"label": "Test MacBook", "pointer": "trackpad"})
    assert r.status_code == 200, r.text
    return r.json()["device_id"], r.json()["device_token"]


def hello(token: str, run_id: str | None = None, mode: str | None = None, resume: str | None = None) -> str:
    return json.dumps({
        "type": "hello", "v": 1, "device_token": token, "run_id": run_id or str(uuid.uuid4()),
        "resume_session_id": resume, "requested_mode": mode, "agent_version": "test", "schema_version": 1,
        "os": "macOS 26.4", "pointer": "trackpad", "display": {"w_pt": 1512, "h_pt": 982, "hz": 120},
    })


GENUINE = {"kb.hold_p50": 95.0, "kb.dd_p50": 150.0, "kb.ud_p50": 55.0, "kb.speed_kps": 6.5, "kb.bksp_rate": 0.05,
           "ms.v_p50": 0.42, "ms.curv_p50": 2.9, "ms.straightness_p50": 0.87, "ms.click_hold_p50": 88.0}
IMPOSTOR = {"kb.hold_p50": 130.0, "kb.dd_p50": 240.0, "kb.ud_p50": 110.0, "kb.speed_kps": 3.4, "kb.bksp_rate": 0.14,
            "ms.v_p50": 0.25, "ms.curv_p50": 5.1, "ms.straightness_p50": 0.66, "ms.click_hold_p50": 131.0}


def make_block(modality: str, t_end: datetime, who: str, rng: random.Random) -> dict:
    spec = load_spec()
    base = GENUINE if who == "a" else IMPOSTOR
    feats = {}
    for i, n in enumerate(spec.names(modality)):
        center = base.get(n, 50.0 + 3 * i)
        if who == "b" and n not in base:
            center *= 1.35
        feats[n] = round(rng.gauss(center, abs(center) * 0.08 + 1e-3), 4)
    if modality == "workflow":
        feats["wf.markov_ll"] = None
    n = {"keyboard": 20, "mouse": 5}.get(modality, 3)
    return {"modality": modality, "t_start": (t_end - timedelta(seconds=4)).isoformat(),
            "t_end": t_end.isoformat(), "n": n, "features": feats}


def make_tick(run_id: str, seq: int, who: str, rng: random.Random, t_end: datetime | None = None,
              session_id: str | None = None, activity: list[int] | None = None) -> str:
    t_end = t_end or datetime.now(UTC)
    return json.dumps({
        "type": "tick", "run_id": run_id, "session_id": session_id, "seq": seq, "t_end": t_end.isoformat(),
        "flags": {"secure_input": False, "injected": 0, "pointer": "trackpad", "late": False, "idle_s": 0.0,
                  "clock_skew": False},
        "counts": {"keys": 24, "mouse_moves": 300, "clicks": 2, "scroll_events": 0, "app_switches": 0},
        "activity": activity if activity is not None else [5, 7, 3, 4, 6],
        "blocks": [make_block("keyboard", t_end, who, rng), make_block("mouse", t_end, who, rng)],
    })


def train_fallback(user_id: str, n: int = 80, seed: int = 1) -> None:
    """Train + activate a fallback model for user_id from synthetic genuine blocks (no Tiger needed)."""
    import asyncio

    import pandas as pd

    from app.core.fallback_model import FallbackUserModel
    from app.core.runtime import rt

    spec = load_spec()
    rng = random.Random(seed)
    now = datetime.now(UTC)
    rows = []
    for i in range(n):
        for m in ("keyboard", "mouse"):
            b = make_block(m, now - timedelta(seconds=5 * (n - i)), "a", rng)
            rows.append({"time": b["t_end"], "modality": m, "features": spec.vectorize(m, b["features"]),
                         "label": "genuine", "actor": "a"})
    df = pd.DataFrame(rows)
    r = rt()
    uid = uuid.UUID(user_id)
    model = FallbackUserModel.train(df, version=1)
    model.save(r.models.user_dir(uid) / "v1")
    return uid
