"""Resumable inference on a frozen corpus. No audio, labels or fingerprints saved."""

import fcntl
import hashlib
import json
import math
import os
from collections.abc import Callable
from pathlib import Path

from .audio import AudioDecodeError, read_audio
from .submission import basename, rank_scores, write_submission


def template_names(template: Path, *, header: bool) -> list[str]:
    rows = template.read_bytes().splitlines()[int(header) :]
    names = []
    for row in rows:
        fields = row.split(b"\t")
        if len(fields) < 2:
            raise ValueError("invalid template row")
        name = basename(fields[0].decode("utf-8"))
        if not name or any(c in name for c in "\r\n\t"):
            raise ValueError("invalid template basename")
        names.append(name)
    if not names or len(names) != len(set(names)):
        raise ValueError("template must have nonempty unique basenames")
    return names


def corpus_files(root: Path, names: list[str]) -> dict[str, Path]:
    root = root.resolve(strict=True)
    wanted, found = set(names), {}
    for candidate in root.rglob("*"):
        if candidate.name not in wanted or not candidate.is_file():
            continue
        path = candidate.resolve(strict=True)
        if not path.is_relative_to(root):
            raise ValueError("corpus symlink leaves the input directory")
        if candidate.name in found:
            raise ValueError("ambiguous corpus: duplicate basename")
        found[candidate.name] = path
    if set(found) != wanted:
        raise ValueError("template files are missing from corpus; no output written")
    return found


def predict(
    root: Path,
    template: Path,
    output: Path,
    partial: Path,
    *,
    score: Callable,
    identity: dict,
    direction: str,
    rank_offset: float,
    header: bool = True,
    max_seconds: float = 120,
    checkpoint_every: int = 50,
    score_min: float | None = None,
    score_max: float | None = None,
) -> dict:
    """Score every listed file; resume only if corpus metadata and model match.

    Journals are synthetic-high raw margins, NOT submission TSVs. Size/mtime
    guards prevent accidental mixed runs; they do not identify or label audio.
    A killed write's incomplete tail is retried. Concurrent writers are rejected.
    """
    if checkpoint_every < 1 or not math.isfinite(max_seconds) or max_seconds <= 0:
        raise ValueError("positive checkpoint interval and duration required")
    rank_scores([0.0], direction=direction, offset=rank_offset)
    paths = [p.resolve() for p in (template, output, partial)]
    if len(set(paths)) != 3:
        raise ValueError("template, output and partial paths must differ")
    names = template_names(template, header=header)
    files = corpus_files(root, names)
    if any(p in files.values() for p in paths[1:]):
        raise ValueError("output must not overwrite input audio")
    inventory = []
    for name in names:
        stat = files[name].stat()
        inventory.append([name, str(files[name]), stat.st_size, stat.st_mtime_ns])
    file_stats = {entry[0]: entry[2:] for entry in inventory}
    metadata = {
        "version": 1,
        "model": identity,
        "profile": "hearsay",
        "max_seconds": max_seconds,
        "header": header,
        "template_sha256": hashlib.sha256(template.read_bytes()).hexdigest(),
        "inventory": inventory,
    }
    prefix = b"# " + json.dumps(metadata, sort_keys=True, allow_nan=False).encode() + b"\n"
    columns = b"file\tmargin\tstatus\n"
    partial.parent.mkdir(parents=True, exist_ok=True)
    with partial.open("a+b") as journal:
        try:
            fcntl.flock(journal, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ValueError("another predictor holds this journal") from exc
        journal.seek(0)
        existing = journal.read()
        scores = {}
        if existing:
            lines = existing.splitlines(keepends=True)
            if len(lines) < 2 or lines[0] != prefix or lines[1] != columns:
                raise ValueError("resume metadata changed; use a new partial file")
            if not existing.endswith(b"\n"):
                tail = len(lines[-1])
                journal.truncate(len(existing) - tail)
                lines.pop()
            for line in lines[2:]:
                fields = line.decode().rstrip("\n").split("\t")
                if len(fields) != 3:
                    raise ValueError("invalid journal row")
                name, value, status = fields
                if name not in files or name in scores:
                    raise ValueError("unexpected or duplicate journal row")
                if status == "unreadable" and value == "":
                    scores[name] = None
                elif status == "ok" and math.isfinite(float(value)):
                    scores[name] = float(value)
                else:
                    raise ValueError("invalid journal score/status")
        else:
            journal.write(prefix + columns)
            journal.flush()
            os.fsync(journal.fileno())
        resumed = len(scores)
        pending = []

        def flush():
            if pending:
                journal.write(b"".join(pending))
                journal.flush()
                os.fsync(journal.fileno())
                pending.clear()

        try:
            for name in names:
                if name in scores:
                    continue
                before = files[name].stat()
                expected = file_stats[name]
                if [before.st_size, before.st_mtime_ns] != expected:
                    raise ValueError("corpus changed during inference")
                try:
                    samples = read_audio(files[name], max_seconds=max_seconds)
                except AudioDecodeError:
                    margin, status = None, "unreadable"
                else:
                    # Model exceptions abort the run; they must never become real scores.
                    margin, status = float(score(samples)), "ok"
                    if not math.isfinite(margin):
                        raise ValueError("model returned a nonfinite margin")
                after = files[name].stat()
                if [after.st_size, after.st_mtime_ns] != expected:
                    raise ValueError("corpus changed during inference")
                scores[name] = margin
                value = "" if margin is None else repr(margin)
                pending.append(f"{name}\t{value}\t{status}\n".encode())
                if len(pending) >= checkpoint_every:
                    flush()
        finally:
            flush()
        if hashlib.sha256(template.read_bytes()).hexdigest() != metadata["template_sha256"]:
            raise ValueError("template changed during inference")
        for name, path in files.items():
            stat = path.stat()
            if [stat.st_size, stat.st_mtime_ns] != file_stats[name]:
                raise ValueError("corpus changed during inference")
        result = write_submission(
            template,
            output,
            scores,
            direction=direction,
            rank_offset=rank_offset,
            header=header,
            score_min=score_min,
            score_max=score_max,
        )
    return {**result, "resumed": resumed, "scored": len(names) - resumed}
