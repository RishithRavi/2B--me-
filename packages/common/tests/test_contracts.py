"""Contract tests (run by every stream's gate): spec ordering, vectors, config, wire types, fixtures."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest
from pydantic import ValidationError

from twobme_common import types as T
from twobme_common.config import load_trust_config, logit, sigmoid
from twobme_common.paths import contracts_dir
from twobme_common.spec import MODALITIES, load_spec

FIX = contracts_dir() / "fixtures"


@pytest.fixture(scope="module")
def spec():
    return load_spec()


def test_spec_shape(spec):
    assert spec.schema_version == 1
    assert tuple(spec.modalities) == MODALITIES
    assert [c for _, c in spec.headline_columns()] == [
        "kb_hold_p50", "kb_dd_p50", "kb_ud_p50", "kb_speed_kps", "kb_bksp_rate",
        "ms_v_p50", "ms_curv_p50", "ms_straightness_p50", "ms_click_hold_p50",
        "sc_v_mean_p50", "wf_switch_rate",
        "tp_rate", "tp_b", "tp_idle_frac", "tp_peak_hz",
    ]
    assert spec.feature("wf.markov_ll").derived == "model"
    assert spec.modality_of("tp.peak_hz") == "temporal"
    assert spec.label("kb.dd_p50") == "flight time"


def test_vectorize_roundtrip_and_nonfinite(spec):
    names = spec.names("keyboard")
    feats = {n: float(i) for i, n in enumerate(names)}
    feats[names[1]] = math.nan
    feats[names[2]] = math.inf
    feats[names[3]] = None
    vec = spec.vectorize("keyboard", feats)
    assert len(vec) == len(names)
    assert vec[0] == 0.0 and vec[1] is None and vec[2] is None and vec[3] is None
    back = spec.devectorize("keyboard", vec)
    assert list(back) == names
    assert spec.devectorize("keyboard", [math.nan] * len(names))[names[0]] is None
    with pytest.raises(KeyError):
        spec.vectorize("keyboard", {"kb.keycode": 1.0})
    with pytest.raises(ValueError):
        spec.devectorize("keyboard", [1.0])


def test_vectorize_partial_dict_fills_none(spec):
    vec = spec.vectorize("mouse", {"ms.v_p50": 0.4})
    assert vec[0] == 0.4 and all(v is None for v in vec[1:])


def test_signature_leaves_resolve(spec):
    for m, leaves in spec.signature.items():
        for leaf in leaves:
            assert spec.signature_features(m, leaf), f"{m}/{leaf} maps to no feature"
    # every goal.txt leaf is present (§5.1.8)
    assert len(spec.signature["keyboard"]) == 6
    assert len(spec.signature["mouse"]) == 6
    assert len(spec.signature["scroll"]) == 4
    assert len(spec.signature["workflow"]) == 5
    assert len(spec.signature["temporal"]) == 5


def test_trust_config():
    cfg = load_trust_config()
    assert cfg.cap == 0.995
    assert cfg.n_ref == {"keyboard": 20, "mouse": 5, "scroll": 3, "workflow": 3, "temporal": 100}
    assert cfg.weights["temporal"] == 0.05
    assert cfg.beta("keyboard") == 6.0
    assert abs(sigmoid(logit(0.97)) - 0.97) < 1e-12
    assert cfg.policy.tiers["R3"].min_conf == 0.90
    # f(0) = 0 with unit slope for the frozen squash params
    C, D, B = cfg.squash.C, cfg.squash.D, cfg.squash.B

    def f(x: float) -> float:
        return min(-D + D * (1 + 1 / C) / (1 / C + math.exp(-x / B)), C)

    assert abs(f(0.0)) < 1e-12
    assert abs((f(1e-6) - f(-1e-6)) / 2e-6 - 1.0) < 1e-4


def test_timestamps_ms_z():
    b = T.Block(modality="scroll", t_start="2026-09-26T10:00:00.123456-04:00", t_end="2026-09-26T14:00:01Z",
                n=1, features={})
    d = json.loads(b.model_dump_json())
    assert d["t_start"] == "2026-09-26T14:00:00.123Z"
    assert d["t_end"] == "2026-09-26T14:00:01.000Z"
    naive = T.MarkerPoint(t="2026-09-26T14:00:00", label="note")
    assert json.loads(naive.model_dump_json())["t"] == "2026-09-26T14:00:00.000Z"


@pytest.mark.parametrize("bad", ["keycode", "window_title", "bundle_id", "x_pt"])
def test_wire_models_forbid_extra_fields(bad):
    tick = json.loads((FIX / "ticks" / "tick_example.json").read_text())
    tick[bad] = 1
    with pytest.raises(ValidationError):
        T.Tick.model_validate(tick)
    blk = json.loads((FIX / "ticks" / "block_keyboard.json").read_text())
    blk[bad] = 1
    with pytest.raises(ValidationError):
        T.Block.model_validate(blk)


def test_block_fixtures_carry_exact_names(spec):
    for m in MODALITIES:
        blk = T.Block.model_validate_json((FIX / "ticks" / f"block_{m}.json").read_text())
        assert blk.modality == m
        spec.check_features(m, blk.features)
    wf = T.Block.model_validate_json((FIX / "ticks" / "block_workflow.json").read_text())
    assert wf.transitions and wf.features["wf.markov_ll"] is None
    tp = T.Block.model_validate_json((FIX / "ticks" / "block_temporal.json").read_text())
    assert tp.psd is not None and len(tp.psd) == 32


def test_tick_and_hello_fixtures():
    tick = T.Tick.model_validate_json((FIX / "ticks" / "tick_example.json").read_text())
    assert tick.seq == 812 and len(tick.activity) == 5 and tick.context and tick.context.modality == "temporal"
    hello = T.Hello.model_validate_json((FIX / "ticks" / "hello_example.json").read_text())
    assert hello.schema_version == 1


def test_agent_message_discriminator():
    from pydantic import TypeAdapter

    ta = TypeAdapter(T.AgentMessage)
    assert isinstance(ta.validate_python({"type": "clock_ping", "t0_ns": 5}), T.ClockPing)
    m = ta.validate_python({"type": "marker", "label": "takeover_start", "t": "2026-09-26T14:00:00Z"})
    assert isinstance(m, T.MarkerMsg)


def test_report_fixtures_validate():
    for kind, model in T.REPORT_MODELS.items():
        model.model_validate_json((FIX / "reports" / f"{kind}.json").read_text())


def test_report_schemas_exist():
    for kind in T.REPORT_MODELS:
        p = Path(contracts_dir()) / "schemas" / f"{kind}.schema.json"
        assert json.loads(p.read_text())["title"]
