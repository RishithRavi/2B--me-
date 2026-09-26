"""History / Tiger endpoints against a real TimescaleDB (skipped unless TEST_TIGER_URL is set)."""

from __future__ import annotations

import os

import pytest
from conftest import ADMIN_TOKEN, login
from test_flows import setup_monitored

pytestmark = pytest.mark.skipif(not os.environ.get("TEST_TIGER_URL"), reason="needs TEST_TIGER_URL")
ADMIN = {"X-Admin-Token": ADMIN_TOKEN}


def flush(client) -> None:
    from app.core.runtime import rt

    client.portal.call(rt().writer.flush)


def test_history_endpoints_roundtrip(client):
    _uid, dev_id, agent = setup_monitored(client)
    for _ in range(4):
        agent.tick("a")
    client.post("/api/demo/marker", json={"device_id": dev_id, "label": "takeover_start"})
    for _ in range(8):
        agent.tick("b")
    flush(client)

    sessions = client.get("/api/history/sessions")
    assert sessions.status_code == 200, sessions.text
    rows = sessions.json()
    assert rows and rows[0]["n_ticks"] >= 12
    sid = rows[0]["session_id"]

    tr = client.get(f"/api/history/trust?session_id={sid}")
    assert tr.status_code == 200, tr.text
    body = tr.json()
    assert body["bucket"] == "10 seconds" and any(p["avg"] is not None for p in body["points"])
    assert any(m["label"] == "takeover_start" for m in body["markers"])

    an = client.get("/api/history/anomalies")
    assert an.status_code == 200 and any(a["kind"] in ("trust_drop", "takeover_suspected") for a in an.json())

    base = client.get(f"/api/history/baseline?modality=keyboard&session_id={sid}")
    assert base.status_code == 200, base.text
    assert {r["column"] for r in base.json()["rows"]} >= {"kb_hold_p50", "kb_dd_p50"}

    st = client.get("/api/tiger/stats").json()
    assert st["ok"] is True
    assert {h["name"] for h in st["hypertables"]} == {"feature_blocks", "trust_ticks", "anomalies", "markers"}
    assert any(j["proc"] == "policy_compression" and j["schedule_interval"] == "00:15:00" for j in st["jobs"])
    assert set(st["caggs"]) >= {"trust_1m", "block_baseline_hourly", "anomaly_daily"}

    cn = client.post("/api/tiger/compress-now", headers=ADMIN)
    assert cn.status_code == 200, cn.text

    # observer (admin cookie) sees everything
    login(client, "admin")
    assert client.get("/api/history/sessions").status_code == 200
    agent.close()


def test_train_from_tiger_rows(client):
    """Enroll-mode blocks written to Tiger train a model via /enroll/train (fallback backend here)."""
    login(client, "a")
    from conftest import register
    from test_flows import Agent

    dev_id, token = register(client)
    agent = Agent(client, token)
    for _ in range(30):
        agent.tick("a")
    flush(client)
    j = client.post("/api/enroll/train", json={"device_id": dev_id, "source": "tiger"})
    assert j.status_code == 200, j.text
    import time

    for _ in range(50):
        mi = client.get("/api/models/active").json()
        if mi["status"] in ("ready", "failed"):
            break
        time.sleep(0.1)
    assert mi["status"] == "ready", mi
    assert mi["n_blocks"]["keyboard"] >= 20
    t = agent.tick("a")
    assert t["level"] != "learning"
    agent.close()
