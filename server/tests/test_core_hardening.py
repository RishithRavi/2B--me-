"""Server-core hardening (§0.3 critical path, §2.2, §5.3): tick robustness, late/duplicate acks, the
server-side privacy checks, and the factor / device / mode security rules. Degraded mode (no Tiger)."""

from __future__ import annotations

import json
import random
import uuid
from datetime import UTC, datetime, timedelta

from conftest import ADMIN_TOKEN, login, make_block, make_tick, register
from test_flows import Agent, agent_token, setup_monitored

ADMIN = {"X-Admin-Token": ADMIN_TOKEN}


def _drt(dev_id: str):
    from app.core.runtime import rt

    return rt().hub.devices[uuid.UUID(dev_id)]


def _trust_reply(agent: Agent, seq: int) -> dict:
    for _ in range(40):
        m = agent.ws.receive_json()
        if m["type"] == "trust" and m.get("seq") == seq:
            return m
        agent.pending.append(m)
    raise AssertionError(f"no trust ack for seq {seq}")


def _send_raw_tick(agent: Agent, tick: dict) -> dict:
    tick["seq"] = agent.seq
    agent.seq += 1
    agent.ws.send_text(json.dumps(tick))
    return _trust_reply(agent, tick["seq"])


# --- 2. tick robustness ------------------------------------------------------------------------------
def test_out_of_order_tick_is_stored_not_scored_and_acked(client, monkeypatch):
    _uid, dev_id, agent = setup_monitored(client)
    first = agent.tick("a")
    drt = _drt(dev_id)
    calls = []
    orig = drt.engine.engine.on_tick
    monkeypatch.setattr(drt.engine.engine, "on_tick", lambda *a, **k: calls.append(a) or orig(*a, **k))
    # t_end before the engine's last tick: the late path (stored, never scored) — and still acked
    old = agent.tick("b", t_end=datetime.now(UTC) - timedelta(seconds=12))
    assert old["type"] == "trust" and calls == []
    assert abs(old["confidence"] - first["confidence"]) < 1e-9
    assert drt.activity  # fresh activity still counts for co-presence
    agent.tick("a")  # the next in-order tick is scored normally
    assert len(calls) == 1
    agent.close()


def test_duplicate_and_flagged_late_ticks_are_acked(client):
    login(client, "a")
    _dev, token = register(client)
    agent = Agent(client, token)
    rng = random.Random(3)
    raw = json.loads(make_tick(agent.run_id, 0, "a", rng, session_id=agent.welcome["session_id"]))
    first = _send_raw_tick(agent, raw)
    agent.ws.send_text(json.dumps(raw))  # same (run_id, seq): a duplicate is acked too, so the outbox drains
    dup = _trust_reply(agent, raw["seq"])
    assert dup["confidence"] == first["confidence"]
    late = json.loads(make_tick(agent.run_id, 0, "a", rng, session_id=agent.welcome["session_id"],
                                t_end=datetime.now(UTC) - timedelta(minutes=3)))
    late["flags"]["late"] = True
    assert _send_raw_tick(agent, late)["type"] == "trust"
    agent.close()


def test_engine_and_scorer_errors_degrade_to_no_evidence(client, monkeypatch):
    uid, dev_id, agent = setup_monitored(client)
    from app.core.runtime import rt

    drt = _drt(dev_id)
    before = agent.tick("a")["confidence"]
    orig = drt.engine.engine.on_tick

    def picky(t_end, idle_s, scores):
        if scores:
            raise ValueError("Invalid typicality")
        return orig(t_end, idle_s, scores)

    monkeypatch.setattr(drt.engine.engine, "on_tick", picky)
    t = agent.tick("b")  # the engine refuses the evidence → applied without evidence, never a dead WS
    assert t["type"] == "trust" and t["confidence"] >= before - 0.01
    monkeypatch.setattr(drt.engine.engine, "on_tick", orig)

    scorer = rt().models.scorer(uuid.UUID(uid))

    def boom(_b):
        raise RuntimeError("scorer exploded")

    monkeypatch.setattr(scorer, "score_block", boom)
    t2 = agent.tick("b")
    assert t2["type"] == "trust" and t2["confidence"] >= t["confidence"] - 0.01  # no evidence → no drop
    agent.close()


def test_ingest_failure_still_acks_and_keeps_the_socket(client, monkeypatch):
    _uid, dev_id, agent = setup_monitored(client)
    from app.core.runtime import rt

    hub = rt().hub
    orig = hub._queue_block_rows

    def boom(*a, **k):
        raise RuntimeError("writer bug")

    monkeypatch.setattr(hub, "_queue_block_rows", boom)
    assert agent.tick("a")["type"] == "trust"
    monkeypatch.setattr(hub, "_queue_block_rows", orig)
    assert agent.tick("a")["type"] == "trust"  # same socket keeps working
    agent.close()


# --- 6. privacy defense in depth ---------------------------------------------------------------------------
def test_transitions_are_category_pairs_and_last_tick_json_has_only_valid_blocks(client, caplog):
    login(client, "a")
    dev_id, token = register(client)
    agent = Agent(client, token)
    from app.core.runtime import rt

    rng = random.Random(5)
    now = datetime.now(UTC)
    wf = make_block("workflow", now, "a", rng)
    wf["transitions"] = {"ide>browser": 2, "com.apple.Safari>ide": 1, "Secret Budget.xlsx>browser": 1, "ide": 3}
    bad = {"modality": "keyboard", "t_start": now.isoformat(), "t_end": now.isoformat(), "n": 1,
           "features": {"kb.secret_title": 1.0}}
    tick = json.loads(make_tick(agent.run_id, 0, "a", rng, session_id=agent.welcome["session_id"]))
    tick["blocks"] = [make_block("mouse", now, "a", rng), wf, bad]
    before = rt().hub.privacy_drops
    _send_raw_tick(agent, tick)
    drt = _drt(dev_id)
    lt = drt.last_tick_json
    assert [b["modality"] for b in lt["blocks"]] == ["mouse", "workflow"]  # the rejected block is not echoed
    assert lt["blocks"][1]["transitions"] == {"ide>browser": 2}
    assert rt().hub.privacy_drops - before == 3
    dumped = json.dumps(lt)
    assert "Safari" not in dumped and "Secret" not in dumped and "secret_title" not in dumped
    stored = [r for t, r in rt().writer._rows if t == "feature_blocks"]
    assert not any("Safari" in json.dumps(r, default=str) or "Secret" in json.dumps(r, default=str) for r in stored)
    assert "Safari" not in caplog.text and "Secret Budget" not in caplog.text  # counted, never logged
    agent.close()


def test_marker_text_capped_at_80_and_agent_text_not_echoed(client):
    _uid, dev_id, agent = setup_monitored(client)
    long = "x" * 200
    agent.ws.send_text(json.dumps({"type": "marker", "label": "note", "t": datetime.now(UTC).isoformat(),
                                   "text": long}))
    agent.tick("a")
    drt = _drt(dev_id)
    assert len(drt.markers[-1].text) == 80
    assert not any(long[:81] in f.text or "x" * 40 in f.text for f in drt.feed)
    r = client.post("/api/demo/marker", json={"device_id": dev_id, "label": "note", "text": "y" * 300})
    assert r.status_code == 200 and len(r.json()["text"]) == 80
    agent.close()


# --- 5. factor / device / mode security --------------------------------------------------------------------
def test_totp_reenroll_needs_recent_verify_or_admin(client):
    me = login(client, "a")
    register(client)
    r1 = client.post("/api/voice/totp/enroll")
    assert r1.status_code == 200 and r1.json()["otpauth_uri"].startswith("otpauth://")
    r2 = client.post("/api/voice/totp/enroll")  # a stolen cookie can't overwrite the secret
    assert r2.status_code == 409, r2.text
    from app.core.runtime import rt
    from twobme_common.types import utcnow

    uid = uuid.UUID(me["user_id"])
    drt = rt().hub.rt(rt().registry.bound_device(uid))  # the bound device (Tiger may hold older ones)
    drt.last_verify_at = utcnow() - timedelta(minutes=6)  # too old
    assert client.post("/api/voice/totp/enroll").status_code == 409
    drt.last_verify_at = utcnow() - timedelta(minutes=1)  # fresh voice/TOTP VERIFY on the bound device
    assert client.post("/api/voice/totp/enroll").status_code == 200
    assert rt().registry.users[uid].totp_secret_enc
    # admin enrolling its own factor is never blocked
    assert client.post("/api/voice/totp/enroll", headers=ADMIN).status_code == 200
    assert client.post("/api/voice/totp/enroll", headers=ADMIN).status_code == 200


def test_new_device_of_enrolled_user_starts_in_monitor_at_030(client):
    uid, dev_id, agent = setup_monitored(client)
    r = client.post("/api/devices/register", json={"label": "stolen cookie", "pointer": "trackpad"})
    assert r.status_code == 200
    from app.core.runtime import rt

    dev2 = rt().registry.devices[uuid.UUID(r.json()["device_id"])]
    assert dev2.mode == "monitor"
    assert abs(rt().hub.rt(dev2).engine.confidence - 0.30) < 1e-6
    # its agent asking for enroll is ignored (a feed line says so) — no 'learning' anchor for the attacker
    a2 = Agent(client, r.json()["device_token"], mode="enroll")
    assert a2.welcome["mode"] == "monitor"
    assert any("ignored" in f.text for f in rt().hub.rt(dev2).feed)
    t = a2.tick("b")
    assert t["level"] != "learning" and t["confidence"] < 0.35
    a2.close()
    agent.close()


def test_first_device_still_enrolls(client):
    login(client, "a")
    _dev, token = register(client)
    agent = Agent(client, token, mode="enroll")
    assert agent.welcome["mode"] == "enroll"
    assert agent.tick("a")["level"] == "learning"
    agent.close()


def test_enroll_mode_needs_admin_once_a_model_is_active(client):
    _uid, dev_id, agent = setup_monitored(client)
    r = client.post("/api/enroll/mode", json={"device_id": dev_id, "mode": "enroll"})
    assert r.status_code == 403, r.text
    assert _drt(dev_id).dev.mode == "monitor"
    assert client.post("/api/enroll/mode", json={"device_id": dev_id, "mode": "monitor"}).status_code == 200
    ok = client.post("/api/enroll/mode", json={"device_id": dev_id, "mode": "enroll"}, headers=ADMIN)
    assert ok.status_code == 200 and _drt(dev_id).dev.mode == "enroll"  # the observer's top-up path
    agent.close()


def test_hello_enroll_ignored_for_enrolled_user(client):
    _uid, dev_id, agent = setup_monitored(client)
    agent.close()
    a2 = Agent(client, agent_token(client, dev_id), mode="enroll")
    assert a2.welcome["mode"] == "monitor"
    assert any("enroll mode" in f.text and "ignored" in f.text for f in _drt(dev_id).feed)
    a2.close()


def test_update_candidates_revoked_before_arming_and_block(client):
    _uid, dev_id, agent = setup_monitored(client)
    from app.core.runtime import rt

    w = rt().writer

    def revokes() -> int:
        return sum(1 for sql, _args in w._stmts if "SET update_candidate = false" in sql)

    for _ in range(4):
        agent.tick("a")
    base = revokes()
    for _ in range(14):
        agent.tick("b")
        if any(m.get("type") == "challenge" for m in agent.pending):
            break
    assert any(m.get("type") == "challenge" for m in agent.pending)
    assert revokes() == base + 1
    sql, args = next((s, a) for s, a in reversed(w._stmts) if "SET update_candidate = false" in s)
    assert args[0] == uuid.UUID(dev_id) and (datetime.now(UTC) - args[1]).total_seconds() >= 119
    d = client.post("/api/checkout/authorize", json={"amount_cents": 200000, "card_last4": "1111"}).json()
    r = client.post(f"/api/voice/challenges/{d['challenge_id']}/response",
                    files={"wav": ("a.wav", b"RIFF", "audio/wav")}, headers={**ADMIN, "X-Fake-Decision": "BLOCK_SPOOF"})
    assert r.status_code == 200, r.text
    assert revokes() == base + 2
    agent.close()


def test_status_reports_model_backend_and_voice_mode(client):
    from app.core.runtime import rt

    st = client.get("/api/status").json()
    assert st["model_backend"] == rt().models.backend_name
    assert st["voice_mode"] == "stub"
    assert st["inference"]["model_backend"] == st["model_backend"]


def test_ws_welcome_after_reconnect_still_acks(client):
    """Regression for the agent outbox: a reconnect re-sends pending ticks; every one is acked."""
    login(client, "a")
    dev_id, token = register(client)
    agent = Agent(client, token)
    rng = random.Random(9)
    raws = [json.loads(make_tick(agent.run_id, i, "a", rng, session_id=agent.welcome["session_id"]))
            for i in range(3)]
    for r in raws:
        agent.ws.send_text(json.dumps(r))
        _trust_reply(agent, r["seq"])
    agent.close()
    a2 = Agent(client, agent_token(client, dev_id), run_id=agent.run_id, resume=agent.welcome["session_id"])
    for r in raws:  # same run, same seqs (the agent re-sends its outbox after a reconnect)
        a2.ws.send_text(json.dumps(r))
        assert _trust_reply(a2, r["seq"])["type"] == "trust"
    assert not any(m.get("type") == "error" for m in a2.pending)
    a2.close()


def test_decision_lookup_falls_back_to_tiger(client):
    """GET /decisions/{id} survives an API restart (the hub's in-memory log is gone) via the Tiger row."""
    import os

    import pytest

    from app.core.runtime import rt

    assert client.get(f"/api/decisions/{uuid.uuid4()}").status_code in (401, 404)
    _uid, _dev, agent = setup_monitored(client)
    assert client.get(f"/api/decisions/{uuid.uuid4()}").status_code == 404
    if not os.environ.get("TEST_TIGER_URL"):
        agent.close()
        pytest.skip("Tiger fallback needs TEST_TIGER_URL")
    for _ in range(10):
        agent.tick("b")
    d = client.post("/api/checkout/authorize", json={"amount_cents": 200000, "card_last4": "1111"}).json()
    client.post(f"/api/voice/challenges/{d['challenge_id']}/response",
                files={"wav": ("a.wav", b"RIFF", "audio/wav")}, headers={**ADMIN, "X-Fake-Decision": "BLOCK_SPOOF"})
    client.portal.call(rt().writer.flush)
    rt().hub.decisions.clear()  # what a restart does to the in-memory decision log
    login(client, "a")  # BLOCK_* revoked a@'s sessions
    det = client.get(f"/api/decisions/{d['decision_id']}")
    assert det.status_code == 200, det.text
    body = det.json()
    assert body["final_trans_status"] == "N" and body["status"] == "final" and body["action"] == "purchase"
    login(client, "b")
    assert client.get(f"/api/decisions/{d['decision_id']}").status_code == 404  # not b@'s decision
    agent.close()


# --- 9. co-presence: the window follows the laptop, a positive needs fresh browser input (SC-4) ---------
_PATTERN = [3, 0, 5, 8, 1, 0, 6, 2, 9, 4, 0, 7, 3, 5, 1, 8, 2, 6, 0, 4]


class _Clock:
    """Stands in for the `time` module inside app.core.presence (wall and monotonic move together)."""

    def __init__(self, t: float):
        self.t = float(t)

    def time(self) -> float:
        return self.t

    def monotonic(self) -> float:
        return self.t


def _binding_cfg():
    from twobme_common.config import load_trust_config

    return load_trust_config().binding


def _correlated(end: int) -> tuple[dict[int, int], dict[int, int]]:
    """Browser input on the 20 s ending at `end`, and the laptop's matching activity."""
    browser = {end - 19 + i: v for i, v in enumerate(_PATTERN)}
    return browser, {t: 3 * v + 1 for t, v in browser.items()}


def _tracker(monkeypatch, t0: int):
    from app.core import presence

    clock = _Clock(t0)
    monkeypatch.setattr(presence, "time", clock)
    tr = presence.PresenceTracker(_binding_cfg())
    browser, agent = _correlated(t0)
    tr.add(list(browser.items()), None)
    assert tr.update(agent).binding == "co-present" and tr.binding()[0] == "co-present"
    return tr, clock, agent


def test_presence_window_anchors_on_the_agent_not_the_last_browser_bucket():
    from app.core.presence import evaluate

    cfg, t0 = _binding_cfg(), 1_000_000
    browser, agent = _correlated(t0)
    assert evaluate(browser, agent, cfg).binding == "co-present"
    # the browser stops at T while the laptop keeps reporting (idle) to T+40: the old seconds age out
    agent.update({t: 0 for t in range(t0 + 1, t0 + 41)})
    ev = evaluate(browser, agent, cfg)
    assert ev.binding == "remote" and ev.active_s < cfg.min_active_s


def test_presence_binding_is_remote_15s_after_the_last_browser_input(monkeypatch):
    t0 = 1_000_000
    tr, clock, agent = _tracker(monkeypatch, t0)
    # a copied cookie shares the idle owner tab's sid: 15 s after A's last input it must not inherit Y
    clock.t = t0 + 15
    agent.update({t: 0 for t in range(t0 + 1, t0 + 16)})
    tr.update(agent)
    assert tr.binding()[0] == "remote"
    tr.update(agent)  # no new agent tick either: still remote
    assert tr.binding()[0] == "remote"


def test_presence_binding_holds_2s_after_the_last_browser_input(monkeypatch):
    t0 = 1_000_000
    tr, clock, agent = _tracker(monkeypatch, t0)
    clock.t = t0 + 2  # the owner stopped typing 2 s ago and presses Pay
    agent.update({t0 + 1: 0, t0 + 2: 0})
    tr.update(agent)
    assert tr.binding()[0] == "co-present"
    # the sticky positive alone (a non-decisive window) also holds while the input is this fresh
    tr.last = tr.last.__class__("remote", None, 0, False)
    assert tr.binding()[0] == "co-present"
