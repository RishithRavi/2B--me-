"""Admin / org panel (§2.4): roster, audit trail, admin actions, org-scope /ws/live, org seed, and the stub-voice
demo control (§5.3 "Voice outcome", §8 C2 stub honesty). Degraded mode (no Tiger) unless TEST_TIGER_URL is set."""

from __future__ import annotations

import os
import uuid
from datetime import timedelta

import pytest
from conftest import ADMIN_TOKEN, login
from starlette.websockets import WebSocketDisconnect
from test_flows import Agent, setup_monitored

ADMIN = {"X-Admin-Token": ADMIN_TOKEN}
WAV = {"wav": ("a.wav", b"RIFF0000", "audio/wav")}
CHECKOUT = {"amount_cents": 200000, "card_last4": "1111"}


def seed(client, n: int = 3) -> list[dict]:
    r = client.post("/api/demo/org/seed", json={"n": n}, headers=ADMIN)
    assert r.status_code == 200, r.text
    return r.json()["employees"]


def audit(client, **q) -> list[dict]:
    r = client.get("/api/admin/audit", params=q, headers=ADMIN)
    assert r.status_code == 200, r.text
    return r.json()


def roster(client) -> list[dict]:
    r = client.get("/api/admin/roster", headers=ADMIN)
    assert r.status_code == 200, r.text
    return r.json()


def row_for(rows: list[dict], device_id: str) -> dict:
    return next(r for r in rows if r["device_id"] == device_id)


def act(client, device_id: str, action: str, **kw):
    return client.post("/api/admin/actions", json={"device_id": device_id, "action": action, **kw}, headers=ADMIN)


def captured(monkeypatch) -> list[tuple[str, object]]:
    """Every live event the hub publishes (type, payload)."""
    from app.core.runtime import rt

    live = rt().live
    seen: list[tuple[str, object]] = []
    orig = live.publish

    def spy(device_id, owner_id, type_, data):  # noqa: ANN001, ANN202
        seen.append((type_, data))
        return orig(device_id, owner_id, type_, data)

    monkeypatch.setattr(live, "publish", spy)
    return seen


# ---------------------------------------------------------------------------------------------------------
def test_org_seed_idempotent_rotates_tokens_and_cannot_log_in(client):
    first = seed(client, 3)
    assert [e["handle"] for e in first] == ["Employee 01", "Employee 02", "Employee 03"]
    assert [e["team"] for e in first] == ["Finance", "Engineering", "Sales"]
    again = seed(client, 3)
    assert [(e["user_id"], e["device_id"]) for e in again] == [(e["user_id"], e["device_id"]) for e in first]
    assert all(a["device_token"] != b["device_token"] for a, b in zip(first, again, strict=True))
    # the rotated-out token is dead, the new one connects
    with client.websocket_connect("/ws/agent") as ws:
        from conftest import hello

        ws.send_text(hello(first[0]["device_token"]))
        assert ws.receive_json()["type"] == "error"
        with pytest.raises(WebSocketDisconnect) as e:
            ws.receive_json()
        assert e.value.code == 4401
    agent = Agent(client, again[0]["device_token"])
    assert agent.welcome["device_id"] == again[0]["device_id"] and agent.welcome["mode"] == "monitor"
    agent.close()
    # pseudonymous: no usable password
    r = client.post("/api/auth/login", json={"email": "emp01@org.2bme.tech", "password": ""})
    assert r.status_code == 401
    # admin only, demo mode
    login(client, "a")
    assert client.post("/api/demo/org/seed", json={"n": 2}).status_code == 403
    assert any(r["kind"] == "admin_action" and "Org demo seeded" in r["summary"] for r in audit(client))


def test_roster_shape_order_and_flags(client):
    _uid, dev_a, agent = setup_monitored(client)  # a@'s real device (non-synthetic)
    emps = seed(client, 3)
    e2, e3 = emps[1]["device_id"], emps[2]["device_id"]
    if row_for(roster(client), e3)["locked"]:  # a reused TEST_TIGER_URL database keeps device state
        act(client, e3, "unlock")
    for _ in range(3):
        agent.tick("a")
    rows = roster(client)
    ids = [r["device_id"] for r in rows]
    assert len(rows) >= 4 and {dev_a, e2, e3} <= set(ids)
    assert all(not r["synthetic"] for r in rows[: ids.index(dev_a) + 1])  # real devices first
    a = row_for(rows, dev_a)
    assert a["synthetic"] is False and a["online"] is True and a["handle"] == "A" and a["team"] is None
    assert a["level"] == "normal" and a["display"] == min(99, round(100 * a["confidence"]))
    assert a["model_version"] == 1 and a["model_backend"] == "fallback" and 1 <= len(a["sparkline"]) <= 60
    assert a["flags"] == []
    syn = [r for r in rows if r["device_id"] in (e2, e3)]
    assert all(r["synthetic"] and r["team"] and r["handle"].startswith("Employee ") for r in syn)
    assert all(r["level"] == "learning" and r["online"] is False for r in syn)
    assert ids.index(e2) < ids.index(e3)  # same severity: by handle

    # an admin-locked employee sorts before the other (offline) synthetic rows
    assert act(client, e3, "lock").status_code == 200
    rows = roster(client)
    ids = [r["device_id"] for r in rows]
    assert ids.index(e3) < ids.index(e2)
    r3 = row_for(rows, e3)
    assert r3["level"] == "locked" and r3["lock_reason"] == "admin_lock" and "admin_locked" in r3["flags"]

    # remote session: a checkout from a browser that is not co-present
    d = client.post("/api/checkout/authorize", json=CHECKOUT).json()
    assert d["binding"] == "remote"
    assert "remote_session" in row_for(roster(client), dev_a)["flags"]

    # insider drift: sustained watch-band confidence while labelled genuine (no takeover marker)
    from app.core.runtime import rt
    from twobme_common.types import TrustPoint, utcnow

    drt = rt().hub.devices[uuid.UUID(dev_a)]
    now = utcnow()
    for i in range(40):
        drt.history.append(TrustPoint(t=now - timedelta(seconds=5 * (40 - i)), confidence=0.62, level="watch"))
    flags = row_for(roster(client), dev_a)["flags"]
    assert "insider_drift" in flags and "takeover_suspected" not in flags

    # takeover: impostor blocks -> suspicious -> proactive challenge armed
    for _ in range(10):
        agent.tick("b")
    r = row_for(roster(client), dev_a)
    assert r["level"] == "suspicious" and r["confidence"] < 0.4
    assert {"takeover_suspected", "challenge_open"} <= set(r["flags"]) and "insider_drift" not in r["flags"]
    assert r["open_challenge"] is not None
    # after an operator reset, the recent takeover window is not mistaken for a slow insider drift
    for _ in range(30):
        drt.history.append(TrustPoint(t=utcnow(), confidence=0.05, level="suspicious"))
    client.post("/api/demo/reset", json={"device_id": dev_a}, headers=ADMIN)
    r = row_for(roster(client), dev_a)
    assert r["level"] == "normal" and "insider_drift" not in r["flags"] and "takeover_suspected" not in r["flags"]
    agent.close()

    login(client, "a")
    assert client.get("/api/admin/roster").status_code == 403


def test_audit_trail_for_a_takeover_flow(client, monkeypatch):
    _uid, dev_a, agent = setup_monitored(client)
    for _ in range(3):
        agent.tick("a")
    r = client.post("/api/demo/marker", json={"device_id": dev_a, "label": "takeover_start"}, headers=ADMIN)
    assert r.status_code == 200
    for _ in range(10):
        agent.tick("b")
    order = client.post("/api/checkout/authorize", json=CHECKOUT).json()  # the attacker's browser (a@'s cookie)
    assert order["trans_status"] == "C"
    # no header: stub + takeover label -> the simulated default is BLOCK_IMPOSTOR
    out = client.post(f"/api/voice/challenges/{order['challenge_id']}/response", files=WAV)
    assert out.status_code == 200, out.text
    assert out.json()["result"]["decision"] == "BLOCK_IMPOSTOR" and out.json()["outcome"]["device_locked"] is True

    rows = audit(client, device_id=dev_a, limit=200)
    kinds = {r["kind"] for r in rows}
    assert {"model", "marker", "trust_change", "alert", "challenge", "decision", "lock"} <= kinds, kinds
    assert [r["t"] for r in rows] == sorted((r["t"] for r in rows), reverse=True)  # newest first
    assert all(r["device_id"] == dev_a and r["handle"] == "A" for r in rows)
    mk = next(r for r in rows if r["kind"] == "marker" and "takeover" in r["summary"])
    assert mk["actor"] == "Observer"  # the admin who pressed Mark takeover
    tc = [r for r in rows if r["kind"] == "trust_change"]
    assert any("→ suspicious" in r["summary"] for r in tc) and len(tc) < 8  # level changes, not every tick
    ch = [r["summary"] for r in rows if r["kind"] == "challenge"]
    assert any("armed" in s for s in ch) and any("BLOCKED" in s and "simulated" in s for s in ch)
    dec = [r["summary"] for r in rows if r["kind"] == "decision"]
    assert any("→ C" in s for s in dec) and any("resolved" in s and "→ N" in s for s in dec)
    assert any(r["kind"] == "lock" and r["severity"] == 5 for r in rows)
    alerts = [r for r in rows if r["kind"] == "alert"]
    assert alerts and all(r["ref_id"] for r in alerts)
    # the operator reset is attributed as well
    client.post("/api/demo/reset", json={"device_id": dev_a}, headers=ADMIN)
    newest = audit(client, device_id=dev_a, limit=5)
    assert any(r["kind"] == "marker" and "reset" in r["summary"] and r["actor"] == "Observer" for r in newest)
    agent.close()


def test_admin_lock_unlock_force_reverify_ack_note(client):
    _uid, dev_a, agent = setup_monitored(client)
    for _ in range(3):
        before = agent.tick("a")["confidence"]
    # lock: admin lock, trust pinned, agent told, decisions N
    r = act(client, dev_a, "lock")
    assert r.status_code == 200, r.text
    row = r.json()
    assert row["kind"] == "admin_action" and row["actor"] == "Observer" and row["summary"] == "Admin lock"
    assert act(client, dev_a, "lock").status_code == 409
    t = agent.tick("a")
    assert t["locked"] is True and t["confidence"] < 0.01
    assert any(m["type"] == "lock" and m["reason"] == "admin_lock" for m in agent.pending)
    d = client.post("/api/decisions", json={"action": "view"}).json()
    assert d["trans_status"] == "N" and "device_locked" in d["reasons"]
    # unlock clears only the admin lock and restores the pinned behavioral confidence
    r = act(client, dev_a, "unlock")
    assert r.status_code == 200, r.text
    t = agent.tick("a")
    assert t["locked"] is False and t["confidence"] >= before - 0.05
    assert act(client, dev_a, "unlock").status_code == 409  # not locked

    # force_reverify -> a proactive challenge through the issuer, sent to the agent; one at a time
    r = act(client, dev_a, "force_reverify")
    assert r.status_code == 200, r.text
    cid = r.json()["ref_id"]
    agent.tick("a")
    assert any(m["type"] == "challenge" and m["challenge_id"] == cid and m["trigger"] == "proactive"
               for m in agent.pending)
    rr = row_for(roster(client), dev_a)
    assert rr["open_challenge"]["challenge_id"] == cid and "challenge_open" in rr["flags"]
    assert "takeover_suspected" not in rr["flags"]  # an admin request is not a detection
    assert act(client, dev_a, "force_reverify").status_code == 409

    # a voice BLOCK lock cannot be cleared by an admin unlock
    login(client, "a")
    order = client.post("/api/checkout/authorize", json=CHECKOUT).json()
    resp = client.post(f"/api/voice/challenges/{order['challenge_id']}/response", files=WAV,
                       headers={**ADMIN, "X-Fake-Decision": "BLOCK_SPOOF"})
    assert resp.json()["outcome"]["device_locked"] is True
    r = act(client, dev_a, "unlock")
    assert r.status_code == 409 and r.json()["detail"] == "voice unlock required"

    # ack_alert on the lock anomaly; note is audit-only
    from app.core.runtime import rt

    tr = rt().extras["audit"].track(uuid.UUID(dev_a))
    assert tr.last_anomaly is not None and tr.last_anomaly.kind == "voice_spoof"
    r = act(client, dev_a, "ack_alert", anomaly_id=str(tr.last_anomaly.id))
    assert r.status_code == 200 and r.json()["summary"] == "Alert acknowledged (voice spoof)"
    assert r.json()["ref_id"] == str(tr.last_anomaly.id)
    assert act(client, dev_a, "ack_alert").status_code == 422
    r = act(client, dev_a, "note", text="called the employee; travelling")
    assert r.status_code == 200 and r.json()["summary"] == "Note: called the employee; travelling"
    assert act(client, dev_a, "note", text="x" * 81).status_code == 422
    assert act(client, dev_a, "note").status_code == 422
    assert act(client, str(uuid.uuid4()), "note", text="hi").status_code == 404
    acts = [r for r in audit(client, device_id=dev_a) if r["kind"] == "admin_action"]
    assert len(acts) >= 5 and all(r["actor"] == "Observer" for r in acts)
    agent.close()


def test_org_scope_ws_gets_every_device_and_audit(client):
    _uid, dev_a, agent = setup_monitored(client)
    emps = seed(client, 2)
    emp_agent = Agent(client, emps[0]["device_token"])
    # a non-admin asking for scope=org is closed with 4403
    login(client, "a")
    with client.websocket_connect("/ws/live?scope=org") as ws:
        assert ws.receive_json()["code"] == 4403
        with pytest.raises(WebSocketDisconnect) as e:
            ws.receive_json()
        assert e.value.code == 4403
    login(client, "admin")
    with client.websocket_connect("/ws/live?scope=org") as ws:
        agent.tick("a")
        emp_agent.tick("a")
        act(client, emps[1]["device_id"], "note", text="org scope check")
        seen: dict[str, set[str]] = {}
        for _ in range(80):
            m = ws.receive_json()
            assert m["type"] != "snapshot"  # no snapshot on open
            seen.setdefault(m["type"], set()).add(m["device_id"])
            if ({dev_a, emps[0]["device_id"]} <= seen.get("trust", set())
                    and emps[1]["device_id"] in seen.get("audit", set())):
                break
        assert {dev_a, emps[0]["device_id"]} <= seen["trust"], seen
        assert emps[1]["device_id"] in seen["audit"], seen
    agent.close()
    emp_agent.close()


def test_stub_voice_header_stripping_override_and_simulated(client, monkeypatch):
    _uid, dev_a, agent = setup_monitored(client)
    for _ in range(3):
        agent.tick("a")
    events = captured(monkeypatch)

    # 1) a user-sent X-Fake-Decision is stripped: label genuine -> VERIFY (the owner's remote step-up resolves Y)
    order = client.post("/api/checkout/authorize", json=CHECKOUT).json()
    r = client.post(f"/api/voice/challenges/{order['challenge_id']}/response", files=WAV,
                    headers={"X-Fake-Decision": "BLOCK_SPOOF"})
    assert r.status_code == 200, r.text
    assert r.json()["result"]["decision"] == "VERIFY" and r.json()["outcome"]["device_locked"] is False
    assert r.json()["outcome"]["resolved_decisions"][0]["trans_status"] == "Y"
    vr = [d for t, d in events if t == "voice_result"]
    assert vr and all(getattr(d, "simulated", False) is True for d in vr)

    # 2) the operator's sticky override (admin, demo mode) drives the next result, without any header
    assert client.post("/api/demo/voice-outcome", json={"device_id": dev_a, "decision": "BLOCK_SPOOF"}).status_code \
        == 403  # a@ is not admin
    r = client.post("/api/demo/voice-outcome", json={"device_id": dev_a, "decision": "RETRY"}, headers=ADMIN)
    assert r.status_code == 200, r.text
    ch = client.post("/api/voice/challenges", json={"reason": "sandbox"}).json()
    for _ in range(2):  # sticky: applies to every response until cleared
        r = client.post(f"/api/voice/challenges/{ch['challenge_id']}/response", files=WAV,
                        headers={"X-Fake-Decision": "VERIFY"})
        assert r.json()["result"]["decision"] == "RETRY", r.text
    # an admin's explicit header still wins over the override
    r = client.post(f"/api/voice/challenges/{ch['challenge_id']}/response", files=WAV,
                    headers={**ADMIN, "X-Fake-Decision": "BLOCK_IMPOSTOR"})
    assert r.json()["result"]["decision"] == "BLOCK_IMPOSTOR"

    # 3) cleared -> label-aware default: a marked takeover defaults to BLOCK_IMPOSTOR
    assert client.post("/api/demo/voice-outcome", json={"device_id": dev_a, "decision": None},
                       headers=ADMIN).status_code == 200
    client.post("/api/demo/marker", json={"device_id": dev_a, "label": "takeover_start"}, headers=ADMIN)
    order = client.post("/api/checkout/authorize", json=CHECKOUT).json()
    r = client.post(f"/api/voice/challenges/{order['challenge_id']}/response", files=WAV,
                    headers={"X-Fake-Decision": "VERIFY"})
    assert r.json()["result"]["decision"] == "BLOCK_IMPOSTOR" and r.json()["outcome"]["device_locked"] is True
    # the returning owner's unlock challenge defaults to VERIFY even with the stale takeover label
    login(client, "a")
    u = client.post("/api/voice/challenges", json={"reason": "unlock"})
    assert u.status_code == 200, u.text
    r = client.post(f"/api/voice/challenges/{u.json()['challenge_id']}/response", files=WAV)
    assert r.json()["result"]["decision"] == "VERIFY" and r.json()["outcome"]["device_locked"] is False
    assert any("simulated" in r["summary"] for r in audit(client, device_id=dev_a) if r["kind"] == "admin_action")

    # 4) real voice mode: the control is refused and the middleware leaves requests alone
    from app.core.runtime import rt

    monkeypatch.setattr(rt().extras["voice_service"], "mode", "real")
    r = client.post("/api/demo/voice-outcome", json={"device_id": dev_a, "decision": "VERIFY"}, headers=ADMIN)
    assert r.status_code == 409
    agent.close()


@pytest.mark.skipif(not os.environ.get("TEST_TIGER_URL"), reason="needs TEST_TIGER_URL")
def test_audit_reads_tiger(client):
    from app.core.runtime import rt

    _uid, dev_a, agent = setup_monitored(client)
    r = act(client, dev_a, "note", text="tiger roundtrip")
    assert r.status_code == 200
    from app.db import history as H

    client.portal.call(rt().writer.flush)
    rows = client.portal.call(H.audit, rt().db, 50, None)
    assert rows is not None and any(x.summary == "Note: tiger roundtrip" for x in rows)
    got = audit(client, limit=50)
    assert any(x["summary"] == "Note: tiger roundtrip" for x in got)
    agent.close()
