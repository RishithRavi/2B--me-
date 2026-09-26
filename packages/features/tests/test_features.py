import json
from pathlib import Path
import numpy as np
import pytest
from hypothesis import given, strategies as st
from sig_test_contracts import spec
from sig_make_fixtures import events
from twobme_features import Accumulators, features_from_events

DISPLAY = {"w_pt": 1512, "h_pt": 982, "hz": 120}


def key_block(delay=0):
    acc = Accumulators(spec(), DISPLAY)
    for i in range(20):
        t = int((i * (100 + delay) + 1) * 1e6)
        acc.add_key(t, True, i, "L_LETTER" if i % 2 else "R_LETTER", False)
        acc.add_key(t + 60_000_000, False, i, "L_LETTER", False)
    return acc.poll(t + 2_000_000_000)[0]


@given(st.floats(min_value=0, max_value=200, allow_nan=False, allow_infinity=False))
def test_flight_delay(delay):
    assert key_block(delay).features["kb.dd_p50"] == pytest.approx(
        100 + delay, abs=0.001
    )


def test_nonoverlap_pending_hold():
    a = Accumulators(spec(), DISPLAY)
    for i in range(20):
        a.add_key(i * 100_000_000, True, i, "L_LETTER", False)
    assert not a.poll(2_000_000_000)
    blocks = a.poll(3_500_000_000)
    assert (
        len(blocks) == 1
        and blocks[0].n == 20
        and blocks[0].features["kb.hold_p50"] is None
    )
    assert not a.poll(4_000_000_000)


def test_minimum_timeout_and_repeat():
    a = Accumulators(spec(), DISPLAY)
    for i in range(7):
        a.add_key(i * 100_000_000, True, i, "L_LETTER", False)
    for i in range(40):
        a.add_key(1_000_000_000 + i * 1_000_000, True, 7, "L_LETTER", True)
    assert not a.poll(20_000_000_000)


def test_scroll_wheel_and_momentum():
    a = Accumulators(spec(), DISPLAY)
    for i in range(5):
        a.add_scroll(i * 30_000_000, 8, 0, False, 0, 0)
    a.add_scroll(180_000_000, 9999, 0, True, 0, 1)
    b = a.poll(31_000_000_000)[0]
    assert b.n == 1 and b.features["sc.momentum_frac"] == pytest.approx(1 / 6)
    assert b.features["sc.v_mean_p50"] < 1


def assert_matches(result, expected, path="ticks"):
    # Floats may differ in the last bits across BLAS/CPU builds (np.correlate in tp.acf_peak).
    if isinstance(expected, float) and isinstance(result, float):
        assert result == pytest.approx(expected, rel=1e-9, abs=1e-12), path
    elif isinstance(expected, dict) and isinstance(result, dict):
        assert result.keys() == expected.keys(), path
        for k in expected:
            assert_matches(result[k], expected[k], f"{path}.{k}")
    elif isinstance(expected, list) and isinstance(result, list):
        assert len(result) == len(expected), path
        for i, (r, e) in enumerate(zip(result, expected)):
            assert_matches(r, e, f"{path}[{i}]")
    else:
        assert result == expected, path


def test_fixture_reproducibility():
    for name, actor in [("genuine_A", "a"), ("impostor_B", "b")]:
        expected = json.loads(
            Path(f"contracts/fixtures/expected/{name}.json").read_text()
        )["ticks"]
        result = [
            {
                "t_ns": t,
                "blocks": [b.model_dump(mode="json") for b in bb],
                "context": c.model_dump(mode="json") if c else None,
            }
            for t, bb, c in features_from_events(events(actor), spec())
        ]
        assert_matches(result, expected)


def test_mouse_sample_rate_invariance():
    def simulate(hz):
        a = Accumulators(spec(), DISPLAY)
        for j in range(5):
            for t in np.linspace(0, 0.5, round(hz * 0.5) + 1):
                a.add_mouse(
                    int((j + t) * 1e9), 100 + 200 * t, 200 + 50 * t * t, "move", 0
                )
            a.poll(int((j + 0.85) * 1e9))
        # gather via explicit accumulation below instead

    vals = []
    for hz in [60, 120]:
        a = Accumulators(spec(), DISPLAY)
        blocks = []
        for j in range(5):
            for t in np.linspace(0, 0.5, round(hz * 0.5) + 1):
                a.add_mouse(
                    int((j + t) * 1e9), 100 + 200 * t, 200 + 50 * t * t, "move", 0
                )
            blocks += a.poll(int((j + 0.85) * 1e9))
        vals.append(blocks[0].features)
    assert vals[0]["ms.v_p50"] == pytest.approx(vals[1]["ms.v_p50"], rel=0.01)
