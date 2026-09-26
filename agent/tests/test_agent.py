import json
import pytest
from sig_test_contracts import spec
from twobme_agent.transport import ClockOffset, Outbox, Transport
from twobme_agent.privacy import local_event, safe_tick, Recorder
from twobme_agent.runtime import TickBuilder


def test_clock_lowest_rtt():
    c = ClockOffset()
    c.pong(100, 1000, 300)
    c.pong(500, 1600, 600)
    assert c.offset == 1050


def test_outbox_dedupe_and_ack(tmp_path):
    out = Outbox(tmp_path / "out.sqlite")
    tick = {"run_id": "r", "seq": 1, "flags": {}}
    out.put(tick)
    out.put(tick)
    assert len(out.pending()) == 1
    out.ack("other", 1)
    assert len(out.pending()) == 1
    out.ack("r", 1)
    assert not out.pending()
    out.close()


def test_transport_rejects_plaintext_remote(tmp_path):
    out = Outbox(tmp_path / "o")
    with pytest.raises(ValueError):
        Transport("http://example.com", "secret", {}, out)
    out.close()


def test_record_allowlist(tmp_path):
    with pytest.raises(ValueError):
        local_event({"ev": "key", "content": "secret"})
    path = tmp_path / "events.jsonl"
    r = Recorder(path, {"ev": "header", "schema_version": 1})
    r.close()
    assert path.stat().st_mode & 0o777 == 0o600


def test_tick_aggregate_boundary():
    b = TickBuilder(spec(), {"w_pt": 1512, "h_pt": 982}, "r")
    c = ClockOffset()
    for i in range(20):
        t = 1_000_000_000 + i * 100_000_000
        b.add(
            {
                "ev": "key",
                "t_ns": t,
                "down": True,
                "slot": i,
                "cls": "L_LETTER",
                "autorepeat": False,
            }
        )
        b.add(
            {
                "ev": "key",
                "t_ns": t + 50_000_000,
                "down": False,
                "slot": i,
                "cls": "L_LETTER",
                "autorepeat": False,
            }
        )
    tick = b.tick(5_000_000_000, "s", c)
    text = json.dumps(tick)
    assert all(x not in text for x in ("slot", "L_LETTER", "x_pt", "y_pt"))
    assert tick["counts"]["keys"] == 20 and tick["blocks"][0]["n"] == 20
    tick["blocks"][0]["raw"] = []
    with pytest.raises(ValueError):
        safe_tick(tick, spec())


def test_secure_input_missing():
    b = TickBuilder(spec(), {"w_pt": 100, "h_pt": 100}, "r")
    b.add({"ev": "key", "t_ns": 0, "down": True, "slot": 1, "cls": "L_LETTER"})
    b.add({"ev": "secure_input", "t_ns": 1, "on": True})
    for i in range(30):
        b.add(
            {"ev": "key", "t_ns": 100 + i, "down": True, "slot": i, "cls": "L_LETTER"}
        )
    assert b.tick(20_000_000_000, "s", ClockOffset())["blocks"] == []


def test_numeric_features_cannot_smuggle_content():
    b = TickBuilder(spec(), {"w_pt": 100, "h_pt": 100}, "r")
    tick = b.tick(5_000_000_000, "s", ClockOffset())
    features = {f["name"]: None for f in spec()["modalities"]["keyboard"]["features"]}
    features["kb.hold_p50"] = "typed-content"
    tick["blocks"] = [
        {
            "modality": "keyboard",
            "t_start": tick["t_end"],
            "t_end": tick["t_end"],
            "n": 20,
            "features": features,
        }
    ]
    with pytest.raises(ValueError, match="Non-numeric"):
        safe_tick(tick, spec())
