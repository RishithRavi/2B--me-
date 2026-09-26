import numpy as np
import pandas as pd
import pytest
from sig_test_contracts import spec
from twobme_ml.model import (
    UserModel,
    eligible,
    temporal_subset,
    markov_ll,
    transition_matrix,
)
from twobme_ml.evaluation import roc_metrics, beta_mle, live_trials, block_from_row
from twobme_ml.update import retrain


def dataset(n=160):
    rng = np.random.default_rng(5)
    names = [f["name"] for f in spec()["modalities"]["keyboard"]["features"]]
    return pd.DataFrame(
        [
            {
                "time": pd.Timestamp("2026-01-01", tz="UTC")
                + pd.Timedelta(seconds=i * 10 + 5),
                "block_start": pd.Timestamp("2026-01-01", tz="UTC")
                + pd.Timedelta(seconds=i * 10),
                "session_id": "enrollment",
                "modality": "keyboard",
                "n": 20,
                "features": dict(zip(names, rng.normal(100, 10, len(names)))),
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


def test_model_purge_calibration_and_roundtrip(tmp_path):
    df = dataset()
    model = UserModel.train(df, {"spec": spec()})
    m = model.models["keyboard"]
    for fold in m["folds"]:
        held = df.iloc[fold["test"]]
        tr = df.iloc[fold["train"]]
        assert (
            (tr.time < held.block_start.min() - pd.Timedelta(seconds=60))
            | (tr.block_start > held.time.max() + pd.Timedelta(seconds=60))
        ).all()
    b = block_from_row(df.iloc[-1], spec())
    s = model.score_block(b)
    assert 0 < s.typicality < 1 and len(s.top) == 5
    model.save(tmp_path)
    restored = UserModel.load(tmp_path)
    assert restored.score_block(b).typicality == s.typicality
    assert restored.version == model.version
    assert m["raw_ref"].shape[0] == len(df)
    # Artifacts written before experimental metadata remain save-compatible.
    del restored.experimental
    restored.save(tmp_path / "resaved")


def test_baseline_exclusions():
    df = dataset(6)
    df.loc[0, "actor"] = "b"
    df.loc[1, "label"] = "impostor"
    df["takeover_excluded"] = False
    df.loc[2, "takeover_excluded"] = True
    df["session_kind"] = "normal"
    df.loc[3, "session_kind"] = "sandbox"
    df["reset_session"] = False
    df.loc[4, "reset_session"] = True
    assert len(eligible(df)) == 1


def test_published_server_training_config_and_vectors(tmp_path):
    from twobme_common.config import load_trust_config
    from twobme_common.spec import load_spec

    df = dataset(110)
    columns = load_spec().names("keyboard")
    df["features"] = df.features.map(lambda f: [f[c] for c in columns])
    b = df.copy()
    b["actor"] = "b"
    b["label"] = "impostor"
    model = UserModel.train(pd.concat([df, b]), load_trust_config())
    assert model.n_blocks["keyboard"] == 110
    assert model.models["keyboard"]["columns"] == columns
    model.version = 1  # The core uses integer artifact versions.
    model.save(tmp_path)
    loaded = UserModel.load(tmp_path)
    assert loaded.version == 1
    assert loaded.score_block(block_from_row(df.iloc[0], load_spec())).typicality is not None


def test_under_gate_disabled():
    with pytest.raises(ValueError, match="No modality"):
        UserModel.train(dataset(99), {"spec": spec()})


def test_lower_gate_requires_explicit_experimental_opt_in():
    df = dataset(13)
    with pytest.raises(ValueError, match="allow_experimental_gate_override"):
        UserModel.train(df, {"spec": spec(), "experimental_gates": {"keyboard": 13}})
    # Sparse low-data modalities such as workflow close about once per minute.
    # Keep enough wall-clock separation for five purged folds.
    df["block_start"] = [
        pd.Timestamp("2026-01-01", tz="UTC") + pd.Timedelta(seconds=i * 120)
        for i in range(len(df))
    ]
    df["time"] = df.block_start + pd.Timedelta(seconds=60)
    model = UserModel.train(
        df,
        {
            "spec": spec(),
            "experimental_gates": {"keyboard": 13},
            "experimental_min_fold_train": {"keyboard": 8},
            "allow_experimental_gate_override": True,
        },
    )
    assert "keyboard" in model.models
    assert len(model.models["keyboard"]["oof_typicality"]) == 13
    assert model.experimental["gate_overrides"] == {"keyboard": 13}


def test_metrics_and_beta():
    assert roc_metrics([0.8, 0.9], [0.1, 0.2])["eer"] == 0
    assert roc_metrics([0.1, 0.2], [0.8, 0.9])["auc"] == 0
    assert beta_mle([0.1] * 9) == (6.0, True)
    assert beta_mle([0.1] * 100)[0] == pytest.approx(9.4912, rel=0.001)
    matrix = transition_matrix([{"transitions": {"ide>browser": 20}}])
    assert np.allclose(matrix.sum(axis=1), 1)
    assert markov_ll({"ide>browser": 1}, matrix) > markov_ll({"ide>chat": 1}, matrix)


def test_parquet_missing_transition_keys_are_absent(tmp_path):
    df = dataset(2)
    df["extras"] = [{"transitions": {"ide>browser": 1}}, {"transitions": {}}]
    df.to_parquet(tmp_path / "rows.parquet")
    rows = pd.read_parquet(tmp_path / "rows.parquet")
    block = block_from_row(rows.iloc[1], spec())
    assert block.transitions == {}
    assert np.isfinite(transition_matrix(rows.extras)).all()
    assert np.isnan(markov_ll(rows.iloc[1].extras["transitions"], transition_matrix([])))


def test_temporal_downsample_per_session():
    df = dataset(12)
    df["modality"] = "temporal"
    assert len(temporal_subset(df)) == 2


def test_minimum_prefix_split_never_uses_b_and_purges_future():
    from twobme_ml.evaluation import minimum_prefix_split
    a = dataset(140)
    b = dataset(200)
    b["actor"] = "b"
    b["label"] = "impostor"
    train, test = minimum_prefix_split(pd.concat([a, b]), "keyboard")
    assert len(train) == 100
    assert len(test) == 34
    assert train.actor.eq("a").all() and test.actor.eq("a").all()
    assert test.block_start.min() > train.time.max() + pd.Timedelta(seconds=60)


def test_trial_arming():
    m = [{"t": "2026-01-01T00:00:00Z", "label": "takeover_start"}]
    ticks = [{"t": f"2026-01-01T00:00:{t:02d}Z", "confidence": 0.3} for t in [5, 10]]
    assert live_trials(m, ticks)[0]["ttd_s"] == 10


def test_update_frozen(monkeypatch):
    monkeypatch.setenv("CONTINUOUS_UPDATE", "false")
    with pytest.raises(ValueError, match="frozen"):
        retrain(None, None, None, None, None, {})


def test_update_bounds_quarantine_and_provenance(monkeypatch):
    import twobme_ml.update as update
    from types import SimpleNamespace

    training = dataset(100)
    training["is_anchor"] = False
    training.loc[:29, "is_anchor"] = True
    candidate = dataset(20)
    candidate["session_id"] = "candidate"
    candidate["time"] = pd.Timestamp("2026-01-02T00:00:00Z")
    candidate["block_start"] = candidate.time - pd.Timedelta(seconds=5)
    candidate["update_candidate"] = True
    candidate["baseline_eligible"] = False
    candidate["is_anchor"] = False
    candidate["takeover_excluded"] = False
    candidate["reset_session"] = False
    candidate["session_kind"] = "normal"
    candidate.loc[0, "takeover_excluded"] = True
    candidate.loc[1, "time"] = pd.Timestamp("2026-01-02T00:19:00Z")
    ah = dataset(10)
    ah["session_id"] = "anchor-holdout"
    bh = dataset(10)
    bh["session_id"] = "b-holdout"
    captured = {}

    class Fake:
        version = "old"
        models = {"keyboard": {}}

        def score_block(self, b):
            return SimpleNamespace(typicality=0.5)

    def train(rows, cfg):
        captured.update(rows=rows, cfg=cfg)
        return Fake()

    monkeypatch.setattr(update.UserModel, "train", train)
    update.retrain(
        Fake(),
        training,
        ah,
        bh,
        candidate,
        {"spec": spec(), "now": "2026-01-02T00:20:00Z"},
    )
    rows = captured["rows"]
    assert len(rows) == 100 and rows.is_anchor.sum() == 30
    assert (rows.session_id == "candidate").sum() == 10
    assert not rows.get("takeover_excluded", False).fillna(False).any()
    assert captured["cfg"]["parent_version"] == "old"


def test_log_sessions_preserve_actor_chronology(tmp_path):
    import json
    from sig_make_fixtures import events
    from twobme_ml.cli import from_logs

    first = events(minutes=1)
    second = [first[0]] + [dict(e, t_ns=e["t_ns"] + 600_000_000_000) for e in first[1:]]
    paths = []
    for name, ev in [("first", first), ("second", second)]:
        path = tmp_path / f"{name}.jsonl"
        path.write_text("".join(json.dumps(e) + "\n" for e in ev))
        paths.append(path)
    rows = from_logs(paths, spec())
    ends = rows.groupby("session_id").time.min().sort_values()
    assert (ends.iloc[1] - ends.iloc[0]).total_seconds() == 600


def test_short_impostor_trace_evaluates_owner_without_fake_identification():
    from twobme_ml.evaluation import evaluate

    a = dataset(200)
    b = dataset(12)
    b["actor"] = "b"
    b["label"] = "impostor"
    b["session_id"] = "short-b-evaluation-only"
    report = evaluate(pd.concat([a, b], ignore_index=True), {"spec": spec()})
    assert report["modalities"]["keyboard"]["n_impostor"] == 12
    assert report["modalities"]["keyboard"]["n_genuine"] == 60
    assert report["modalities"]["keyboard"]["eer"] is not None
    assert report["identification"]["accuracy"] is None
    assert report["identification"]["confusion"] == [[0, 0], [0, 0]]
    assert any("Two-way identification unavailable" in note for note in report["notes"])
    assert report["modalities"]["temporal"]["eer"] is None
