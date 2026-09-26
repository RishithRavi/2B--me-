import json

from hearsay.cli import main


def test_eval_uses_configured_costs_and_marks_rules_provisional(tmp_path, capsys):
    scores = tmp_path / "scores.json"
    scores.write_text(json.dumps({"real": [-1, -2], "synth": [1, 2]}))
    assert main(["eval", str(scores)]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result == {
        "n": 4,
        "eer": 0,
        "rules_confirmed": False,
        "min_dcf_a": 0,
        "min_dcf_b": 0,
        "mean_min_dcf": 0,
    }


def test_writer_cli(tmp_path, capsys):
    scores, template, output = (
        tmp_path / name for name in ("scores.json", "template.tsv", "out.tsv")
    )
    scores.write_text('{"a.wav": -1, "b.wav": 1}')
    template.write_text("file\tscore\na.wav\t0.006\nb.wav\t0.006\n")
    assert (
        main(
            [
                "write-tsv",
                str(scores),
                "--template",
                str(template),
                "-o",
                str(output),
                "--direction",
                "synth_high",
                "--rank-offset",
                "-0.5",
            ]
        )
        == 0
    )
    assert json.loads(capsys.readouterr().out)["rows"] == 2
    assert output.read_text() == "file\tscore\na.wav\t0.25000000\nb.wav\t0.75000000\n"


def test_direction_cli_never_labels_inverted_scores_passed(tmp_path, capsys):
    scores = tmp_path / "scores.json"
    scores.write_text(json.dumps({"real": [1] * 20, "synth": [-1] * 20}))
    assert main(["direction-check", str(scores)]) == 2
    captured = capsys.readouterr()
    assert not captured.out
    assert "failed" in captured.err


def test_predict_cli_decodes_wav_and_resumes_without_model_load(tmp_path, monkeypatch, capsys):
    import numpy as np
    import soundfile as sf
    from hearsay.models import Countermeasure

    root = tmp_path / "audio"
    root.mkdir()
    sf.write(root / "a.wav", np.ones(16000) * 0.1, 16000)
    sf.write(root / "b.wav", np.ones(16000) * 0.2, 16000)
    template = tmp_path / "template.tsv"
    template.write_text("file\tscore\na.wav\t0.006\nb.wav\t0.006\n")
    detector = Countermeasure(
        lambda x: [float(x.mean()), 0], model="test", revision="a" * 40, spoof_index=0
    )
    monkeypatch.setattr(Countermeasure, "load", lambda **_: detector)
    args = [
        "predict",
        str(root),
        "--template",
        str(template),
        "-o",
        str(tmp_path / "out.tsv"),
        "--partial",
        str(tmp_path / "partial.tsv"),
        "--revision",
        "a" * 40,
        "--direction",
        "synth_high",
        "--rank-offset",
        "-0.5",
    ]
    assert main(args) == 0
    assert json.loads(capsys.readouterr().out)["scored"] == 2
    monkeypatch.setattr(
        Countermeasure,
        "load",
        lambda **_: (_ for _ in ()).throw(
            AssertionError("completed journal must not load a model")
        ),
    )
    assert main(args) == 0
    assert json.loads(capsys.readouterr().out)["resumed"] == 2
