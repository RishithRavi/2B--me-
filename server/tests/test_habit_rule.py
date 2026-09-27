"""Demo habit rule (settings.habit_word_delete): every 30 s of active typing without a single ⌥⌫ word delete
drops trust by 17 percentage points. Owner-set, disclosed in the feed, off by default, and only for agents that
report TickCounts.word_deletes. Degraded mode (no Tiger)."""

from __future__ import annotations

import json
import uuid

from conftest import make_tick
from test_flows import Agent, setup_monitored


def _hub():
    from app.core.runtime import rt

    return rt().hub


def _tick(agent: Agent, word_deletes: int | None, keys: int = 24) -> dict:
    d = json.loads(make_tick(agent.run_id, agent.seq, "a", agent.rng, session_id=agent.welcome["session_id"]))
    d["counts"]["keys"] = keys
    if word_deletes is not None:
        d["counts"]["word_deletes"] = word_deletes
    sent = agent.seq
    agent.seq += 1
    agent.ws.send_text(json.dumps(d))
    for _ in range(40):
        m = agent.ws.receive_json()
        if m["type"] == "trust" and m.get("seq") == sent:
            return m
        agent.pending.append(m)
    raise AssertionError("no trust reply")


def _enable(monkeypatch) -> None:
    monkeypatch.setattr(_hub().s, "habit_word_delete", True)


def test_30s_of_typing_without_word_delete_drops_17_points(client, monkeypatch):
    _enable(monkeypatch)
    _uid, dev_id, agent = setup_monitored(client)
    confs = [_tick(agent, 0)["confidence"] for _ in range(6)]  # 6 ticks x 5 s = 30 s of typing
    assert confs[4] > 0.9
    assert abs((confs[4] - confs[5]) - 0.17) < 0.03  # the 6th tick applies the drop (plus that tick's own evidence)
    drt = _hub().devices[uuid.UUID(dev_id)]
    assert drt.habit_typing_s == 0.0  # the window restarts after a drop
    assert any("Habit rule" in f.text and "owner-set" in f.text for f in drt.feed)
    agent.close()


def test_a_word_delete_resets_the_window(client, monkeypatch):
    _enable(monkeypatch)
    _uid, _dev_id, agent = setup_monitored(client)
    confs = []
    for i in range(12):
        confs.append(_tick(agent, 1 if i % 5 == 4 else 0)["confidence"])  # a ⌥⌫ every 25 s
    assert min(confs) > 0.9
    agent.close()


def test_idle_ticks_do_not_count_as_typing(client, monkeypatch):
    _enable(monkeypatch)
    _uid, dev_id, agent = setup_monitored(client)
    for _ in range(10):
        _tick(agent, 0, keys=0)
    assert _hub().devices[uuid.UUID(dev_id)].habit_typing_s == 0.0
    agent.close()


def test_agents_without_the_count_and_the_default_off_switch_never_drop(client, monkeypatch):
    _uid, _dev_id, agent = setup_monitored(client)
    off = [_tick(agent, 0)["confidence"] for _ in range(8)]  # rule off by default
    _enable(monkeypatch)
    unreported = [_tick(agent, None)["confidence"] for _ in range(8)]  # agent doesn't report word_deletes
    assert min(off + unreported) > 0.9
    agent.close()
