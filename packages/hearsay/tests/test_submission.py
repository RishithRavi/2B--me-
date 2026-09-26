import math

import pytest
from hearsay.submission import rank_scores, write_submission


def test_preserves_all_bytes_except_second_column(tmp_path):
    template, output = tmp_path / "template.tsv", tmp_path / "result.tsv"
    original = (
        b"\xef\xbb\xbffile\tlabel\textra\r\nfolder/b.wav\t0.006\t keep \r\na.wav\t0.006\tlast"
    )
    template.write_bytes(original)
    result = write_submission(
        template, output, {"a.wav": 1, "/files/b.wav": -1}, direction="synth_high", rank_offset=-0.5
    )
    assert result["rows"] == 2
    assert output.read_bytes() == original.replace(b"0.006", b"0.25000000", 1).replace(
        b"0.006", b"0.75000000", 1
    )
    assert template.read_bytes() == original


def test_average_ranks_and_last_direction_flip():
    assert rank_scores([3, 1, 1, 2], direction="synth_high", offset=-0.5) == [
        0.875,
        0.25,
        0.25,
        0.625,
    ]
    assert rank_scores([3, 1, 1, 2], direction="bona_high", offset=-0.5) == [
        0.125,
        0.75,
        0.75,
        0.375,
    ]


@pytest.mark.parametrize("direction", ["synth_high", "bona_high"])
def test_unreadable_goes_to_real_end(tmp_path, direction):
    template, output = tmp_path / "template", tmp_path / "out"
    template.write_bytes(b"a.wav\t0.006\nb.wav\t0.006\nc.wav\t0.006\n")
    result = write_submission(
        template,
        output,
        {"a.wav": 1, "b.wav": None, "c.wav": 2},
        direction=direction,
        rank_offset=-0.5,
        header=False,
    )
    values = [float(row.split(b"\t")[1]) for row in output.read_bytes().splitlines()]
    assert values[1] == (min(values) if direction == "synth_high" else max(values))
    assert result["unreadable"] == 1


@pytest.mark.parametrize(
    "scores",
    [
        {},
        {"a.wav": 1, "b.wav": 2},
        {"a.wav": math.nan},
        {"a.wav": math.inf},
        {"x/a.wav": 1, "y/a.wav": 2},
    ],
)
def test_invalid_or_unattempted_scores_never_write(tmp_path, scores):
    template, output = tmp_path / "template", tmp_path / "out"
    template.write_bytes(b"file\tscore\na.wav\t0.006\n")
    output.write_text("previous valid run")
    with pytest.raises(ValueError):
        write_submission(template, output, scores, direction="synth_high", rank_offset=-0.5)
    assert output.read_text() == "previous valid run"


def test_literal_plan_formula_range_guard(tmp_path):
    template = tmp_path / "template"
    template.write_bytes(b"file\tscore\na.wav\t0.006\n")
    assert rank_scores([1], direction="synth_high", offset=0.5) == [1.5]
    with pytest.raises(ValueError, match="range"):
        write_submission(
            template,
            tmp_path / "out",
            {"a.wav": 1},
            direction="synth_high",
            rank_offset=0.5,
            score_min=0,
            score_max=1,
        )


def test_duplicate_template_and_in_place_are_rejected(tmp_path):
    template = tmp_path / "template"
    template.write_bytes(b"file\tscore\nx/a.wav\t0\ny/a.wav\t0\n")
    for output in (template, tmp_path / "out"):
        with pytest.raises(ValueError):
            write_submission(
                template, output, {"a.wav": 1}, direction="synth_high", rank_offset=-0.5
            )
