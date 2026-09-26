"""Byte-preserving template writer; only the second TSV field may change."""

import math
import os
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path


def basename(value: str) -> str:
    return value.replace("\\", "/").rsplit("/", 1)[-1]


def rank_scores(values: Sequence[float], *, direction: str, offset: float) -> list[float]:
    """Average 1-based ranks, offset configurable until official rules are frozen.

    The approved correction in contracts/REQUESTS.md uses midranks with -0.5.
    Reversing the ranks is the last transformation before the offset/scale.
    """
    if direction not in {"synth_high", "bona_high"}:
        raise ValueError("direction must be synth_high or bona_high")
    if not values or not math.isfinite(offset):
        raise ValueError("nonempty scores and finite offset required")
    if any(math.isnan(v) or v == math.inf for v in values):
        raise ValueError("only finite scores or the unreadable -inf sentinel are allowed")
    order = sorted(range(len(values)), key=values.__getitem__)
    result = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i + 1
        while j < len(order) and values[order[j]] == values[order[i]]:
            j += 1
        rank = (i + 1 + j) / 2
        if direction == "bona_high":
            rank = len(values) + 1 - rank
        for k in order[i:j]:
            result[k] = (rank + offset) / len(values)
        i = j
    return result


def write_submission(
    template: Path,
    output: Path,
    scores: Mapping[str, float | None],
    *,
    direction: str,
    rank_offset: float,
    header: bool = True,
    score_min: float | None = None,
    score_max: float | None = None,
) -> dict:
    """None means attempted but unreadable, never unattempted or model failure."""
    if template.resolve() == output.resolve():
        raise ValueError("output must not overwrite the official template")
    lines = template.read_bytes().splitlines(keepends=True)
    rows = lines[1:] if header else lines
    if not rows:
        raise ValueError("template has no rows")
    names = []
    for line in rows:
        fields = line.split(b"\t")
        if len(fields) < 2:
            raise ValueError("template rows need at least two TSV columns")
        names.append(basename(fields[0].decode("utf-8")))
    if len(set(names)) != len(names):
        raise ValueError("duplicate basenames in template")
    normalized = {}
    for name, value in scores.items():
        key = basename(name)
        if key in normalized:
            raise ValueError("duplicate prediction basenames")
        if value is not None and not math.isfinite(value):
            raise ValueError("prediction must be finite, or null for unreadable audio")
        normalized[key] = value
    if set(names) != set(normalized):
        raise ValueError("every template file must be attempted exactly once; no extra files")
    ranked = rank_scores(
        [normalized[n] if normalized[n] is not None else -math.inf for n in names],
        direction=direction,
        offset=rank_offset,
    )
    rendered = lines[:1] if header else []
    for line, value in zip(rows, ranked, strict=True):
        encoded = f"{value:.8f}".encode("ascii")
        written_value = float(encoded)
        if written_value == 0.006:
            raise ValueError("a final score equals the forbidden 0.006 placeholder")
        if (score_min is not None and written_value < score_min) or (
            score_max is not None and written_value > score_max
        ):
            raise ValueError("rank score outside configured official range; check rank_offset")
        if line.endswith(b"\r\n"):
            body, ending = line[:-2], b"\r\n"
        elif line.endswith(b"\n"):
            body, ending = line[:-1], b"\n"
        else:
            body, ending = line, b""
        fields = body.split(b"\t")
        fields[1] = encoded
        rendered.append(b"\t".join(fields) + ending)
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=output.parent, prefix=".hearsay-")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(b"".join(rendered))
        os.replace(tmp, output)
    finally:
        Path(tmp).unlink(missing_ok=True)
    return {
        "rows": len(rows),
        "unreadable": sum(v is None for v in normalized.values()),
        "direction": direction,
    }
