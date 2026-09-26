import fcntl

import numpy as np
import pytest
from hearsay.audio import AudioDecodeError
from hearsay.predict import predict


@pytest.fixture
def job(tmp_path, monkeypatch):
    root = tmp_path / "audio"
    root.mkdir()
    for i in range(3):
        (root / f"{i}.wav").write_text(str(i))
    template = tmp_path / "template.tsv"
    template.write_bytes(b"file\tscore\n2.wav\t0.006\n0.wav\t0.006\n1.wav\t0.006\n")
    monkeypatch.setattr(
        "hearsay.predict.read_audio", lambda p, **_: np.array([float(p.read_text())])
    )
    return {
        "root": root,
        "template": template,
        "output": tmp_path / "out.tsv",
        "partial": tmp_path / "predictions.partial.tsv",
        "score": lambda x: float(x[0]),
        "identity": {"model": "test", "revision": "a" * 40},
        "direction": "synth_high",
        "rank_offset": -0.5,
    }


def test_resume_reuses_scores_and_preserves_template_order(job):
    result = predict(**job)
    assert result == {
        "rows": 3,
        "unreadable": 0,
        "direction": "synth_high",
        "resumed": 0,
        "scored": 3,
    }
    original = job["output"].read_bytes()
    job["score"] = lambda _: pytest.fail("completed files must not run inference again")
    assert predict(**job)["resumed"] == 3
    assert job["output"].read_bytes() == original
    assert original.splitlines()[1].startswith(b"2.wav\t0.83333333")


def test_interrupted_model_keeps_completed_rows_but_no_final_output(job):
    def fail_on_third(x):
        if x[0] == 1:
            raise RuntimeError("model failed")
        return float(x[0])

    job["score"] = fail_on_third
    with pytest.raises(RuntimeError):
        predict(**job)
    assert not job["output"].exists()
    assert b"unreadable" not in job["partial"].read_bytes()
    job["score"] = lambda x: float(x[0])
    result = predict(**job)
    assert result["resumed"] == 2 and result["scored"] == 1


def test_partial_last_write_is_retried(job):
    predict(**job)
    journal = job["partial"].read_bytes()
    job["partial"].write_bytes(journal[: journal.rfind(b"1.wav\t")] + b"1.wav\t")
    result = predict(**job)
    assert result["resumed"] == 2 and result["scored"] == 1


@pytest.mark.parametrize("change", ["model", "file", "template"])
def test_resume_rejects_changed_inputs(job, change):
    predict(**job)
    if change == "model":
        job["identity"] = {"model": "different"}
    elif change == "file":
        (job["root"] / "0.wav").write_text("10")
    else:
        job["template"].write_bytes(job["template"].read_bytes() + b"\n")
    with pytest.raises(ValueError):
        predict(**job)


def test_unreadable_is_attempted_once_and_ranked_real(job, monkeypatch):
    def decode(path, **_):
        if path.name == "2.wav":
            raise AudioDecodeError("corrupt")
        return np.array([float(path.read_text())])

    monkeypatch.setattr("hearsay.predict.read_audio", decode)
    assert predict(**job)["unreadable"] == 1
    assert b"2.wav\t\tunreadable\n" in job["partial"].read_bytes()
    assert job["output"].read_bytes().splitlines()[1] == b"2.wav\t0.16666667"
    assert predict(**job)["scored"] == 0


@pytest.mark.parametrize("problem", ["missing", "duplicate", "symlink"])
def test_ambiguous_or_missing_files_fail_before_model(job, problem, tmp_path):
    if problem == "missing":
        (job["root"] / "0.wav").unlink()
    else:
        nested = job["root"] / "nested"
        nested.mkdir()
        if problem == "duplicate":
            (nested / "0.wav").write_text("0")
        else:
            outside = tmp_path / "outside.wav"
            outside.write_text("0")
            (job["root"] / "0.wav").unlink()
            (nested / "0.wav").symlink_to(outside)
    job["score"] = lambda _: pytest.fail("preflight must precede inference")
    with pytest.raises(ValueError):
        predict(**job)
    assert not job["output"].exists()


def test_nonfinite_model_results_never_become_real(job):
    job["score"] = lambda _: float("nan")
    with pytest.raises(ValueError, match="nonfinite"):
        predict(**job)
    assert not job["output"].exists()


def test_concurrent_writer_rejected(job):
    with job["partial"].open("wb") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(ValueError, match="another predictor"):
            predict(**job)


def test_input_audio_cannot_be_overwritten(job):
    job["output"] = job["root"] / "0.wav"
    with pytest.raises(ValueError, match="overwrite"):
        predict(**job)


def test_mutation_during_scoring_does_not_publish(job):
    def score(x):
        (job["root"] / "2.wav").write_text("12345")
        return float(x[0])

    job["score"] = score
    with pytest.raises(ValueError, match="changed"):
        predict(**job)
    assert not job["output"].exists()


def test_duplicate_complete_journal_row_is_not_silently_reused(job):
    predict(**job)
    with job["partial"].open("ab") as stream:
        stream.write(b"0.wav\t0.0\tok\n")
    with pytest.raises(ValueError, match="duplicate"):
        predict(**job)


@pytest.mark.parametrize("target", ["template", "earlier_audio"])
def test_final_publication_rechecks_inputs(job, target):
    def score(x):
        if x[0] == 1:  # last row, after 2.wav has already been scored
            path = job["template"] if target == "template" else job["root"] / "2.wav"
            path.write_bytes(path.read_bytes() + b" ")
        return float(x[0])

    job["score"] = score
    with pytest.raises(ValueError, match="changed"):
        predict(**job)
    assert not job["output"].exists()
