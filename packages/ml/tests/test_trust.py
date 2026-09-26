from datetime import datetime, timezone
import numpy as np
import pytest
from scipy.special import ndtr
from sig_test_contracts import trust_config
from twobme_common.types import BlockScore
from twobme_ml.trust import TrustEngine


def score(t, m="keyboard", n=20):
    return BlockScore(
        modality=m,
        t_end=datetime.now(timezone.utc),
        n=n,
        typicality=float(t),
        llr_direct=None,
        top=[],
    )


def test_idle_partition():
    cfg = trust_config()
    a = TrustEngine(cfg, initial=0.97)
    b = TrustEngine(cfg, initial=0.97)
    a.on_tick(0, 0, [])
    b.on_tick(0, 0, [])
    last = 0.97
    for t in range(5, 301, 5):
        s = a.on_tick(t, t, [])
        assert s.confidence <= last
        last = s.confidence
    assert a.on_tick(300, 300, []).confidence == pytest.approx(
        b.on_tick(300, 300, []).confidence, abs=1e-9
    )


def test_restore_no_anchor():
    a = TrustEngine(trust_config(), initial=0.97)
    a.on_tick(0, 0, [])
    for t in range(5, 60, 5):
        s = a.on_tick(t, 0, [score(0.01), score(0.01, "mouse", 5)])
    restored = TrustEngine.from_dict(a.to_dict())
    assert restored.on_tick(120, 120, []).confidence <= s.confidence
    assert restored.on_tick(125, 0, [score(0.001)]).level != "locked"


def test_published_config_object_yaml_and_flat_agree():
    from twobme_common.config import load_trust_config

    engines = [TrustEngine(cfg, initial=0.97) for cfg in
               (load_trust_config(), load_trust_config().model_dump(), trust_config())]
    engines.append(TrustEngine(initial=0.97))
    for t, idle, typicality in [(0, 0, .8), (5, 0, .02), (120, 110, .1), (125, 0, .7)]:
        states = [e.on_tick(t, idle, [score(typicality)]) for e in engines]
        assert all(s.confidence == pytest.approx(states[0].confidence) for s in states)
    restored = TrustEngine.from_dict(engines[0].to_dict())
    assert restored.on_tick(130, 0, []).confidence == engines[0].on_tick(130, 0, []).confidence


def test_published_idle_settings_are_honored():
    from twobme_common.config import load_trust_config

    cfg = load_trust_config().model_dump()
    cfg["idle"]["grace_s"] = 0
    cfg["idle"]["half_life_idle_s"] = 10
    e = TrustEngine(cfg, initial=.8)
    e.on_tick(0, 0, [])
    assert e.on_tick(10, 10, []).confidence == pytest.approx(.4)


def test_missing_and_multiple_blocks():
    a = TrustEngine(trust_config())
    s = a.on_tick(1, 0, [score(0.7), score(0.7)])
    assert s.per_modality["keyboard"].n_blocks == 2
    assert not a.on_tick(2, 0, []).per_modality
    with pytest.raises(ValueError):
        a.on_tick(1, 0, [])


def test_retired_modalities_do_not_change_trust():
    engine = TrustEngine(trust_config(), initial=0.5)
    before = engine.L
    state = engine.on_tick(1, 0, [score(0.001, "workflow"), score(0.001, "temporal")])
    assert state.logit == before
    assert state.per_modality == {}


def test_seeded_monte_carlo():
    rng = np.random.default_rng(2048)
    cfg = trust_config()
    high = 0
    never = 0
    total = 200 * 360
    for run in range(200):
        engine = TrustEngine(cfg, initial=0.97)
        engine.on_tick(0, 0, [])
        z = rng.normal(size=2)
        low = 0
        armed = False
        for tick in range(1, 361):
            z = 0.6 * z + np.sqrt(1 - 0.6**2) * rng.normal(size=2)
            t = ndtr(z)
            s = engine.on_tick(tick * 5, 0, [score(t[0]), score(t[1], "mouse", 5)])
            high += s.confidence >= 0.9
            low = low + 1 if s.confidence < 0.4 else 0
            armed |= low >= 2
        never += not armed
    assert high / total >= 0.95
    medians = {}
    for initial, max_ttd in [(0.995, 60), (0.97, 45)]:
        ttd = []
        for run in range(200):
            e = TrustEngine(cfg, initial=initial)
            e.on_tick(0, 0, [])
            low = 0
            for tick in range(1, 121):
                t = rng.beta(1, 6, size=2)
                s = e.on_tick(tick * 5, 0, [score(t[0]), score(t[1], "mouse", 5)])
                low = low + 1 if s.confidence < 0.4 else 0
                if low >= 2:
                    ttd.append(tick * 5)
                    break
            else:
                ttd.append(600)
        medians[str(initial)] = float(np.median(ttd))
        assert np.median(ttd) <= max_ttd
    result = {
        "genuine_ge_090": high / total,
        "never_armed": never / 200,
        "median_ttd_s": medians,
    }
    print(result)
    import json
    from pathlib import Path

    output_path = Path("work/trust_simulation.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2))
    assert never / 200 >= 0.84
