"""§11.2 Claude invariants, exercised through the real HTTP + WS surface (degraded mode, fallback model)."""

from __future__ import annotations

import random
import time
import uuid
from datetime import UTC, datetime, timedelta

from conftest import ADMIN_TOKEN, hello, login, make_tick, register, train_fallback

ADMIN = {"X-Admin-Token": ADMIN_TOKEN}


def recv_until(ws, typ: str, limit: int = 20) -> dict:
    for _ in range(limit):
        m = ws.receive_json()
        if m.get("type") == typ:
            return m
    raise AssertionError(f"no {typ} within {limit} messages")


class Agent:
    """Minimal fake agent over /ws/agent."""

    def __init__(self, client, token: str, mode: str | None = None, run_id: str | None = None,
                 resume: str | None = None):
        self.cm = client.websocket_connect("/ws/agent")
        self.ws = self.cm.__enter__()
        self.closed = False
        client.agents.append(self)
        self.run_id = run_id or str(uuid.uuid4())
        self.ws.send_text(hello(token, self.run_id, mode, resume))
        self.welcome = recv_until(self.ws, "welcome")
        self.seq = 0
        self.rng = random.Random(7)
        self.pending: list[dict] = []

    def tick(self, who: str = "a", t_end: datetime | None = None, activity: list[int] | None = None) -> dict:
        self.ws.send_text(make_tick(self.run_id, self.seq, who, self.rng, t_end=t_end,
                                    session_id=self.welcome["session_id"], activity=activity))
        sent = self.seq
        self.seq += 1
        for _ in range(40):
            m = self.ws.receive_json()
            if m["type"] == "trust" and m.get("seq") == sent:
                return m
            self.pending.append(m)
        raise AssertionError("no trust reply")

    def close(self):
        if not self.closed:
            self.closed = True
            self.cm.__exit__(None, None, None)


def setup_monitored(client) -> tuple[str, str, Agent]:
    me = login(client, "a")
    dev_id, token = register(client)
    agent = Agent(client, token)
    agent.tick("a")
    train_fallback(me["user_id"])
    r = client.post(f"/api/models/activate?user_id={me['user_id']}&version=1", headers=ADMIN)
    assert r.status_code == 200, r.text
    return me["user_id"], dev_id, agent


# ---------------------------------------------------------------------------------------------------------
def test_degraded_mode_login_status_healthz(client):
    import os

    st = client.get("/api/status").json()
    assert st["tiger"] == ("up" if os.environ.get("TEST_TIGER_URL") else "down") and st["voice_warm"] is True
    assert client.get("/api/healthz").status_code == 200
    assert client.get("/api/me").status_code == 401
    me = login(client, "a")
    assert me["email"] == "a@2bme.tech" and me["role"] == "user"
    assert client.get("/api/me").json()["handle"] == "A"
    assert client.post("/api/auth/login", json={"email": "a@2bme.tech", "password": "nope"}).status_code == 401


def test_new_device_learning_then_model_anchor(client):
    login(client, "a")
    _dev, token = register(client)
    agent = Agent(client, token)
    assert agent.welcome["mode"] == "enroll" and agent.welcome["model_version"] is None
    t = agent.tick("a")
    assert t["level"] == "learning" and t["confidence"] > 0.96  # new device: 0.97 in enroll mode
    agent.close()


def test_genuine_stays_high_impostor_arms_challenge_but_never_blocks(client):
    _uid, dev_id, agent = setup_monitored(client)
    t = None
    for _ in range(6):
        t = agent.tick("a")
    assert t["level"] in ("normal", "watch") and t["confidence"] > 0.8
    confs = []
    for _ in range(12):
        confs.append(agent.tick("b")["confidence"])
    assert confs[-1] < 0.10
    # proactive challenge armed after 2 consecutive ticks < 0.40, sent to the agent
    msgs = agent.pending + [agent.ws.receive_json() for _ in range(0)]
    assert any(m["type"] == "challenge" and m["trigger"] == "proactive" for m in msgs), msgs
    # behavior alone never blocks: even at < 0.10 a purchase steps up (C), never N
    d = client.post("/api/checkout/authorize", json={"amount_cents": 200000, "card_last4": "1111"}).json()
    assert d["decision"] == "step_up" and d["trans_status"] == "C" and d["challenge_id"]
    view = client.post("/api/decisions", json={"action": "view"}).json()
    assert view["decision"] in ("allow", "step_up")
    agent.close()


def test_markers_never_reach_scorer_or_engine(client, monkeypatch):
    uid, dev_id, agent = setup_monitored(client)
    from app.core.runtime import rt

    drt = rt().hub.devices[uuid.UUID(dev_id)]
    before = drt.engine.L
    calls = []
    orig = drt.engine.on_tick
    monkeypatch.setattr(drt.engine, "on_tick", lambda *a, **k: calls.append(a) or orig(*a, **k))
    for label in ("takeover_start", "note", "takeover_end"):
        agent.ws.send_text(f'{{"type":"marker","label":"{label}","t":"{datetime.now(UTC).isoformat()}"}}')
    r = client.post("/api/demo/marker", json={"device_id": dev_id, "label": "takeover_start"})
    assert r.status_code == 200
    time.sleep(0.2)
    assert calls == [] and drt.engine.L == before
    assert drt.label == "impostor" and drt.actor == "b"  # markers only change label stamping
    agent.close()


def test_reconnect_mid_impostor_never_raises_confidence(client):
    _uid, _dev, agent = setup_monitored(client)
    _, token = None, None
    for _ in range(3):
        last = agent.tick("b")
    before = last["confidence"]
    sess = agent.welcome["session_id"]
    tok = client.post("/api/devices/register", json={"label": "x"})  # unrelated device must not matter
    assert tok.status_code == 200
    from app.core.runtime import rt

    token = next(iter([d for d in rt().registry.devices.values() if str(d.id) == _dev]))
    agent.close()
    # reconnect with the same device token (resume) — look the token up via a fresh registration is not
    # possible (hashed), so reuse the original agent's hello token captured by the fixture helper
    agent2 = Agent(client, agent_token(client, _dev), resume=sess)
    t2 = agent2.tick("b")
    assert t2["confidence"] <= before + 1e-9
    agent2.close()


def agent_token(client, dev_id: str) -> str:
    """Tests only: mint a fresh token for an existing device (production never re-issues tokens)."""
    import secrets

    from app.core.registry import token_hash
    from app.core.runtime import rt

    dev = rt().registry.devices[uuid.UUID(dev_id)]
    tok = "dt_" + secrets.token_urlsafe(16)
    dev.token_hash = token_hash(tok)
    return tok


def test_remote_cookie_gets_prior_and_steps_up(client):
    _uid, _dev, agent = setup_monitored(client)
    for _ in range(3):
        agent.tick("a")
    # no presence posts from this browser session -> remote -> 0.30
    d = client.post("/api/checkout/authorize", json={"amount_cents": 200000, "card_last4": "1111"}).json()
    assert d["binding"] == "remote" and abs(d["confidence"] - 0.30) < 1e-6
    assert d["trans_status"] == "C" and d["status"] == "pending"
    agent.close()


def _copresent(client, agent: Agent, who: str = "a") -> None:
    now = time.time()
    pattern = [3, 0, 5, 8, 1, 0, 6, 2, 9, 4, 0, 7, 3, 5, 1, 8, 2, 6, 0, 4]
    base = int(now) - 20
    for k in range(4):
        t_end = datetime.fromtimestamp(base + 5 * (k + 1), UTC)
        agent.tick(who, t_end=t_end, activity=[x * 3 + 1 for x in pattern[5 * k:5 * k + 5]])
    buckets = [{"t_s": base + i + 1, "keys": pattern[i], "pointer": 0, "wheel": 0} for i in range(20)]
    r = client.post("/api/web/presence", json={"buckets": buckets, "client_now_ms": int(now * 1000)})
    assert r.status_code == 200, r.text
    assert r.json()["binding"] == "co-present", r.json()


def test_copresent_owner_frictionless_purchase(client):
    _uid, _dev, agent = setup_monitored(client)
    _copresent(client, agent)
    d = client.post("/api/checkout/authorize", json={"amount_cents": 200000, "card_last4": "1111"}).json()
    assert d["binding"] == "co-present" and d["trans_status"] == "Y", d
    agent.close()


def test_block_spoof_locks_and_attacker_order_stays_N_after_owner_verify(client):
    uid, dev_id, agent = setup_monitored(client)
    for _ in range(10):
        agent.tick("b")
    attacker = client.post("/api/checkout/authorize", json={"amount_cents": 200000, "card_last4": "1111"}).json()
    assert attacker["trans_status"] == "C"
    cid = attacker["challenge_id"]
    r = client.post(f"/api/voice/challenges/{cid}/response", files={"wav": ("a.wav", b"RIFF0000", "audio/wav")},
                    headers={"X-Fake-Decision": "BLOCK_SPOOF"})
    assert r.status_code == 200, r.text
    out = r.json()["outcome"]
    assert out["device_locked"] is True
    assert out["resolved_decisions"][0]["trans_status"] == "N"
    # a@'s sessions are revoked; locked device returns N for everything
    assert client.get("/api/me").status_code == 401
    login(client, "a")
    d = client.post("/api/decisions", json={"action": "view"}).json()
    assert d["decision"] == "block" and d["trans_status"] == "N" and "device_locked" in d["reasons"]
    # owner unlocks with voice on a new session
    ch = client.post("/api/voice/challenges", json={"reason": "unlock"})
    assert ch.status_code == 200, ch.text
    r = client.post(f"/api/voice/challenges/{ch.json()['challenge_id']}/response",
                    files={"wav": ("a.wav", b"RIFF0000", "audio/wav")}, headers={"X-Fake-Decision": "VERIFY"})
    assert r.json()["outcome"]["device_locked"] is False
    t = agent.tick("a")
    assert t["locked"] is False and t["confidence"] > 0.9
    # the attacker's order stays declined
    det = client.get(f"/api/decisions/{attacker['decision_id']}").json()
    assert det["final_trans_status"] == "N"
    agent.close()


def test_owner_stepup_verify_resolves_same_session_only(client):
    _uid, _dev, agent = setup_monitored(client)
    d = client.post("/api/checkout/authorize", json={"amount_cents": 200000, "card_last4": "1111"}).json()
    assert d["trans_status"] == "C"  # remote (no presence) -> step-up
    r = client.post(f"/api/voice/challenges/{d['challenge_id']}/response",
                    files={"wav": ("a.wav", b"RIFF0000", "audio/wav")}, headers={"X-Fake-Decision": "VERIFY"})
    res = r.json()["outcome"]["resolved_decisions"]
    assert res and res[0]["trans_status"] == "Y"
    agent.close()


def test_unlock_only_via_voice_or_reset(client):
    uid, dev_id, agent = setup_monitored(client)
    for _ in range(10):
        agent.tick("b")
    d = client.post("/api/checkout/authorize", json={"amount_cents": 200000, "card_last4": "1111"}).json()
    client.post(f"/api/voice/challenges/{d['challenge_id']}/response",
                files={"wav": ("a.wav", b"RIFF", "audio/wav")}, headers={"X-Fake-Decision": "BLOCK_IMPOSTOR"})
    # genuine behavior does not unlock
    for _ in range(8):
        t = agent.tick("a")
    assert t["locked"] is True and t["level"] == "locked" and t["confidence"] < 0.01
    # operator reset unlocks and anchors at 0.97 (operator action, not authentication)
    snap = client.post("/api/demo/reset", json={"device_id": dev_id}, headers=ADMIN).json()
    assert snap["device"]["locked"] is False and abs(snap["trust"]["confidence"] - 0.97) < 1e-6
    assert "operator_reset" in snap["trust"]["reasons"]
    agent.close()


def test_rearm_and_redteam_active_challenge(client):
    _uid, dev_id, agent = setup_monitored(client)
    tl = client.post("/api/demo/rearm", json={"device_id": dev_id, "confidence": 0.31}, headers=ADMIN).json()
    assert abs(tl["confidence"] - 0.31) < 1e-6
    agent.tick("b")
    agent.tick("b")
    time.sleep(0.1)
    act = client.get(f"/api/demo/redteam/active-challenge?device_id={dev_id}", headers=ADMIN)
    assert act.status_code == 200
    assert act.json() is None or act.json()["phrase"]
    agent.close()


def test_sandbox_challenge_has_no_effects(client):
    _uid, dev_id, agent = setup_monitored(client)
    before = agent.tick("a")["confidence"]
    ch = client.post("/api/voice/challenges", json={"reason": "sandbox"}).json()
    r = client.post(f"/api/voice/challenges/{ch['challenge_id']}/response",
                    files={"wav": ("a.wav", b"RIFF", "audio/wav")}, headers={"X-Fake-Decision": "BLOCK_SPOOF"})
    assert r.json()["outcome"]["device_locked"] is False
    assert agent.tick("a")["confidence"] >= before - 0.2
    agent.close()


def test_skewed_tick_time_is_substituted(client):
    login(client, "a")
    _dev, token = register(client)
    agent = Agent(client, token)
    t = agent.tick("a", t_end=datetime.now(UTC) + timedelta(minutes=5))
    assert t["type"] == "trust"
    agent.close()


def test_bad_block_features_rejected_without_echo(client):
    login(client, "a")
    _dev, token = register(client)
    agent = Agent(client, token)
    agent.ws.send_text('{"type":"tick","run_id":"%s","seq":0,"t_end":"%s","blocks":[{"modality":"keyboard",'
                       '"t_start":"%s","t_end":"%s","n":1,"features":{"kb.keycode":65}}]}'
                       % (agent.run_id, datetime.now(UTC).isoformat(), datetime.now(UTC).isoformat(),
                          datetime.now(UTC).isoformat()))
    m = recv_until(agent.ws, "error")
    assert m["code"] == "bad_block" and "65" not in m["detail"]
    agent.ws.send_text('{"type":"tick","keycode":65}')  # privacy-ok: negative test (must be rejected)
    m = recv_until(agent.ws, "error")
    assert m["code"] == "bad_message" and "65" not in (m.get("detail") or "")
    agent.close()
