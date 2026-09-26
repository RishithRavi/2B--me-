import numpy as np
import pandas as pd
import pytest
from sig_test_contracts import spec
from twobme_common.spec import load_spec
from twobme_ml.evaluation import block_from_row, roc_metrics
from twobme_ml.model import (
    ACTIVE_MODALITIES,
    BAND_POWERS,
    GATES,
    EnsembleV2,
    UserModel,
    enrollment_gates,
    fold_minimum,
)


def blocks(modality, n, *, names=None, spacing=10, duration=5, seed=5, shift=0.0):
    rng = np.random.default_rng(seed)
    names = names or [f["name"] for f in spec()["modalities"][modality]["features"]]
    t0 = pd.Timestamp("2026-01-01", tz="UTC")
    return pd.DataFrame(
        [
            {
                "time": t0 + pd.Timedelta(seconds=i * spacing + duration),
                "block_start": t0 + pd.Timedelta(seconds=i * spacing),
                "session_id": "enrollment",
                "modality": modality,
                "n": 20,
                "features": dict(zip(names, np.exp(rng.normal(4 + shift, 0.25, len(names))))),
                "extras": {},
                "label": "genuine",
                "actor": "a",
                "schema_version": 1,
                "baseline_eligible": True,
                "update_candidate": False,
            }
            for i in range(n)
        ]
    )


def typicalities(model, df, s):
    return [model.score_block(block_from_row(r, s)).typicality for _, r in df.iterrows()]


def test_gates_come_from_the_spec_with_contract_fallback():
    assert enrollment_gates(load_spec().model_dump())["workflow"] == 13
    assert enrollment_gates(spec()) == GATES  # the isolated test spec has no enroll_gate
    assert ACTIVE_MODALITIES == ("keyboard", "mouse", "scroll")
    assert (fold_minimum(13), fold_minimum(20), fold_minimum(30), fold_minimum(100)) == (8, 14, 20, 20)


def test_workflow_is_not_trained_or_scored(tmp_path):
    canonical = load_spec().model_dump()
    workflow = blocks("workflow", 20, names=load_spec().names("workflow"), spacing=120, duration=60)
    workflow["extras"] = [{"transitions": {"ide>browser": 1 + i % 2}} for i in range(len(workflow))]
    scroll = blocks("scroll", 40, names=load_spec().names("scroll"), spacing=120, duration=60)
    df = pd.concat([workflow, scroll], ignore_index=True)
    model = UserModel.train(df, {"spec": canonical})
    assert set(model.models) == {"scroll"}
    assert "workflow" not in model.n_blocks
    assert model.score_block(block_from_row(workflow.iloc[0], canonical)) is None
    # A legacy artifact that contains the retired modality is made inactive on load.
    model.models["workflow"] = model.models["scroll"]
    model.save(tmp_path)
    restored = UserModel.load(tmp_path)
    assert set(restored.models) == {"scroll"}
    assert restored.disabled["workflow"] == "Removed from the active identity model"


def test_v2_tail_scores_a_missing_owner_habit_as_surprising():
    x = np.exp(np.random.default_rng(3).normal(4, 0.2, size=(60, 4)))
    ens = EnsembleV2().fit(x, columns=["kb.hold_p50", "kb.dd_p50", "kb.ud_p50", "kb.shift_lead_p50"])
    typical = np.median(x, axis=0)
    missing = typical.copy()
    missing[3] = np.nan
    tail = ens.member_names.index("tail")
    assert ens.raw(missing[None])[0, tail] > ens.raw(typical[None])[0, tail] + 0.5


def test_v2_separates_an_impostor_lacking_owner_habits_that_v1_hides():
    owner = blocks("keyboard", 160, seed=5)
    genuine = blocks("keyboard", 40, seed=7)
    impostor = blocks("keyboard", 40, seed=6)  # same values; never uses shift or corrections
    impostor["features"] = [
        {**f, "kb.shift_lead_p50": None, "kb.bksp_run_mean": None, "kb.pre_bksp_dd_p50": None}
        for f in impostor.features
    ]
    auc = {}
    for detector in ("v1", "v2"):
        model = UserModel.train(owner, {"spec": spec(), "detector": detector})
        auc[detector] = roc_metrics(
            typicalities(model, genuine, spec()), typicalities(model, impostor, spec())
        )["auc"]
    # v1 imputes the owner's median, so missing habits look perfectly typical.
    assert auc["v1"] < 0.6
    assert auc["v2"] > auc["v1"] + 0.15


def test_v2_band_powers_are_shares_invariant_to_activity_volume():
    names = [f["name"] for f in spec()["modalities"]["temporal"]["features"]]
    rng = np.random.default_rng(11)
    x = np.exp(rng.normal(0, 0.3, size=(80, len(names))))
    ens = EnsembleV2().fit(x, columns=names)
    probe = np.exp(rng.normal(0, 0.3, size=(5, len(names))))
    louder = probe.copy()
    bands = [names.index(b) for b in BAND_POWERS]
    louder[:, bands] *= 8.0  # same rhythm, more events: absolute powers scale together
    assert np.array_equal(ens.raw(probe), ens.raw(louder))


def test_cross_conformal_scoring_keeps_fresh_owner_blocks_calibrated():
    # Fresh owner blocks should average typicality 0.5. Scoring them with the full-data
    # model against out-of-fold references makes them look too typical at small n.
    s = spec()
    fresh = blocks("scroll", 150, seed=999)
    means = {"cv+": [], "full": []}
    for seed in range(30, 38):
        owner = blocks("scroll", 40, seed=seed)
        for calibration, values in means.items():
            model = UserModel.train(owner, {"spec": s, "calibration": calibration})
            values.append(np.mean(typicalities(model, fresh, s)))
            if calibration == "cv+":
                assert abs(np.mean(model.models["scroll"]["oof_typicality"]) - 0.5) < 0.02
    assert abs(np.mean(means["cv+"]) - 0.5) < 0.04
    assert np.mean(means["full"]) > np.mean(means["cv+"]) + 0.015


def test_detector_and_calibration_fail_closed_and_are_recorded(tmp_path):
    df = blocks("scroll", 40)
    with pytest.raises(ValueError, match="Unknown detector"):
        UserModel.train(df, {"spec": spec(), "detector": "v9"})
    with pytest.raises(ValueError, match="Unknown calibration"):
        UserModel.train(df, {"spec": spec(), "calibration": "none"})
    legacy = UserModel.train(df, {"spec": spec(), "detector": "v1"})
    assert legacy.calibration == "full" and "fold_fits" not in legacy.models["scroll"]
    model = UserModel.train(df, {"spec": spec()})
    assert (model.detector, model.calibration) == ("v2", "cv+")
    model.save(tmp_path)
    restored = UserModel.load(tmp_path)
    b = block_from_row(df.iloc[3], spec())
    assert restored.score_block(b).typicality == model.score_block(b).typicality
    meta = (tmp_path / "meta.json").read_text()
    assert '"detector": "v2"' in meta and "cross-conformal" in meta


def test_temporal_is_not_trained_or_scored():
    s = spec()
    temporal = blocks("temporal", 420, spacing=5, duration=30)
    scroll = blocks("scroll", 40, spacing=120, duration=60)
    df = pd.concat([temporal, scroll], ignore_index=True)
    model = UserModel.train(df, {"spec": s})
    assert set(model.models) == {"scroll"}
    assert "temporal" not in model.n_blocks
    assert model.score_block(block_from_row(temporal.iloc[0], s)) is None
