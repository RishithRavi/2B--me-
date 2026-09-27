"""History / Tiger endpoints against a real TimescaleDB (skipped unless TEST_TIGER_URL is set)."""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta

import pytest
from conftest import ADMIN_TOKEN, login, make_tick
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


def _anchor_tick(agent: Agent, t_end: datetime) -> dict:
    """A tick with no blocks only restates the engine's anchor: delta_logit 0 at the current confidence."""
    raw = json.loads(make_tick(agent.run_id, agent.seq, "a", agent.rng, t_end=t_end,
                               session_id=agent.welcome["session_id"]))
    raw["blocks"] = []
    agent.ws.send_text(json.dumps(raw))
    agent.seq += 1
    for _ in range(40):
        m = agent.ws.receive_json()
        if m["type"] == "trust" and m.get("seq") == raw["seq"]:
            return m
        agent.pending.append(m)
    raise AssertionError("no trust reply")


def test_anchor_tick_is_not_session_min_or_timeline_start(client):
    """SC-2: the 0.30 anchor tick of a new device of an enrolled user carries no evidence, so it never becomes
    the session's Min/avg (red "Min 30%") or the first point of its trust timeline."""
    _uid, _dev1, agent = setup_monitored(client)
    agent.tick("a")
    r = client.post("/api/devices/register", json={"label": "second laptop", "pointer": "trackpad"})
    dev2 = r.json()["device_id"]
    agent2 = Agent(client, r.json()["device_token"])
    # explicit tick times 1 s apart (after the session start, inside the 30 s clock-skew allowance)
    t0 = datetime.now(UTC) + timedelta(seconds=1)
    first = _anchor_tick(agent2, t0)
    assert abs(first["confidence"] - 0.30) < 1e-6  # new device of an enrolled user: the 0.30 anchor, no evidence
    confs = [agent2.tick("a", t_end=t0 + timedelta(seconds=1 + i))["confidence"] for i in range(6)]
    flush(client)

    s2 = client.get(f"/api/history/sessions?limit=5&device_id={dev2}").json()[0]
    assert s2["n_ticks"] == 7  # the anchor tick still counts as a tick
    assert abs(s2["avg_confidence"] - sum(confs) / len(confs)) < 1e-4  # ... but not in avg/min
    assert abs(s2["min_confidence"] - min(confs)) < 1e-4

    tr = client.get("/api/history/trust", params={"session_id": s2["session_id"],
                                                  "end": (t0 + timedelta(seconds=10)).isoformat()}).json()
    pts = [p for p in tr["points"] if p["avg"] is not None]
    assert tr["bucket"] == "10 seconds" and pts and all(abs(p["min"] - 0.30) > 1e-6 for p in pts)
    # the raw timeline over just the anchor tick's second is empty: it never draws the 30% start band
    only = client.get("/api/history/trust", params={
        "device_id": dev2, "bucket": "10 seconds", "start": (t0 - timedelta(milliseconds=500)).isoformat(),
        "end": (t0 + timedelta(milliseconds=500)).isoformat()})
    assert only.status_code == 200, only.text
    assert only.json()["points"] and all(p["avg"] is None and p["min"] is None and p["last"] is None
                                         for p in only.json()["points"])
    # ... while the next second (a real tick) does draw a point
    nxt = client.get("/api/history/trust", params={
        "device_id": dev2, "bucket": "10 seconds", "start": (t0 + timedelta(milliseconds=500)).isoformat(),
        "end": (t0 + timedelta(milliseconds=1500)).isoformat()}).json()
    assert any(p["avg"] is not None and abs(p["avg"] - confs[0]) < 1e-4 for p in nxt["points"])
    agent2.close()
    agent.close()
