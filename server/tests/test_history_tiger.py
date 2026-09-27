"""History / Tiger endpoints against a real TimescaleDB (skipped unless TEST_TIGER_URL is set)."""

from __future__ import annotations

import os

import pytest
from conftest import ADMIN_TOKEN, login
from test_flows import Agent, setup_monitored

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


def test_history_device_filter(client):
    """SC-1: ?device_id= scopes /history/sessions and /history/anomalies (breach trace-back). An admin filters
    any device; a user stays scoped to their own devices, so a foreign device id returns []."""
    _uid, dev1, agent = setup_monitored(client)
    for _ in range(4):
        agent.tick("a")
    for _ in range(8):
        agent.tick("b")  # dev1: trust drop -> anomalies
    r = client.post("/api/devices/register", json={"label": "second laptop", "pointer": "trackpad"})
    dev2 = r.json()["device_id"]
    agent2 = Agent(client, r.json()["device_token"])
    for _ in range(3):
        agent2.tick("a")
    flush(client)

    # existing callers (no device_id) still see both devices
    both = {x["device_id"] for x in client.get("/api/history/sessions?limit=200").json()}
    assert {dev1, dev2} <= both
    rows2 = client.get(f"/api/history/sessions?limit=200&device_id={dev2}").json()
    assert rows2 and all(x["device_id"] == dev2 for x in rows2)
    # dev2's session is the newest; with the filter dev1's session is still returned at limit=1
    newest = client.get("/api/history/sessions?limit=1").json()
    assert [x["device_id"] for x in newest] == [dev2]
    only1 = client.get(f"/api/history/sessions?limit=1&device_id={dev1}").json()
    assert [x["device_id"] for x in only1] == [dev1]

    an1 = client.get(f"/api/history/anomalies?limit=500&device_id={dev1}").json()
    assert an1 and all(a["device_id"] == dev1 for a in an1)
    assert all(a["device_id"] == dev2 for a in client.get(f"/api/history/anomalies?device_id={dev2}").json())
    assert client.get("/api/history/sessions?device_id=not-a-uuid").status_code == 422

    # a non-admin is still scoped to their own user: another user's device id returns nothing
    login(client, "b")
    assert client.get(f"/api/history/sessions?device_id={dev1}").json() == []
    assert client.get(f"/api/history/anomalies?device_id={dev1}").json() == []
    # the observer (admin) filters any device
    login(client, "admin")
    adm = client.get(f"/api/history/sessions?limit=200&device_id={dev1}").json()
    assert adm and all(x["device_id"] == dev1 for x in adm)
    adm_an = client.get(f"/api/history/anomalies?limit=500&device_id={dev1}").json()
    assert {a["id"] for a in adm_an} == {a["id"] for a in an1}
    agent2.close()
    agent.close()
