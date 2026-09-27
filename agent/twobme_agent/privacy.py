"""Allowlisted local events and aggregate-only network messages."""

import json
import math
from pathlib import Path

FIELDS = {
    "header": {
        "ev",
        "schema_version",
        "display",
        "pointer",
        "label",
        "actor",
        "synthetic",
    },
    "key": {"t_ns", "ev", "down", "slot", "cls", "autorepeat", "inj"},
    "chord": {"t_ns", "ev", "kind"},
    "mouse": {"t_ns", "ev", "kind", "x_pt", "y_pt", "button", "inj"},
    "scroll": {"t_ns", "ev", "dy", "dx", "continuous", "phase", "momentum"},
    "app": {"t_ns", "ev", "cat", "via"},
    "window": {"t_ns", "ev"},
    "os": {"t_ns", "ev", "event"},
    "secure_input": {"t_ns", "ev", "on"},
    "label": {"t_ns", "ev", "label", "actor"},
    "habit": {"t_ns", "ev", "kind"},
}
HABIT_KINDS = {"word_delete"}


def local_event(e):
    kind = e.get("ev")
    if kind not in FIELDS or set(e) - FIELDS[kind]:
        raise ValueError("Unexpected local event fields")
    if kind == "habit" and e.get("kind") not in HABIT_KINDS:
        raise ValueError("Unexpected habit kind")
    return e


def finite_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def safe_tick(tick, spec):
    from twobme_features.accumulators import names

    allowed = {
        "type",
        "run_id",
        "session_id",
        "seq",
        "t_end",
        "flags",
        "counts",
        "activity",
        "blocks",
        "context",
    }
    if set(tick) - allowed:
        raise ValueError("Unexpected tick fields")
    for block in tick["blocks"] + ([tick["context"]] if tick.get("context") else []):
        if set(block) - {
            "modality",
            "t_start",
            "t_end",
            "n",
            "features",
            "transitions",
            "psd",
        }:
            raise ValueError("Non-aggregate block")
        if set(block["features"]) != set(names(spec, block["modality"])):
            raise ValueError("Noncanonical features")
        if any(
            v is not None and not finite_number(v) for v in block["features"].values()
        ):
            raise ValueError("Non-numeric feature")
        if not isinstance(block["n"], int) or block["n"] < 0:
            raise ValueError("Invalid block count")
        if block.get("psd") is not None and (
            len(block["psd"]) != 32 or not all(finite_number(v) for v in block["psd"])
        ):
            raise ValueError("Invalid PSD")
        if block.get("transitions"):
            cats = {
                "browser",
                "ide",
                "terminal",
                "chat",
                "docs",
                "media",
                "system",
                "other",
            }
            for pair, value in block["transitions"].items():
                if not isinstance(value, int) or value < 0:
                    raise ValueError("Invalid transition count")
                if len(pair.split(">")) != 2 or not set(pair.split(">")) <= cats:
                    raise ValueError("Noncategory transition")
    if set(tick["flags"]) - {
        "secure_input",
        "injected",
        "pointer",
        "late",
        "idle_s",
        "clock_skew",
    }:
        raise ValueError("Unexpected flags")
    if set(tick["counts"]) - {
        "keys",
        "mouse_moves",
        "clicks",
        "scroll_events",
        "app_switches",
        "word_deletes",
    }:
        raise ValueError("Unexpected counts")
    if any(not isinstance(v, int) or v < 0 for v in tick["counts"].values()):
        raise ValueError("Invalid counts")
    if len(tick["activity"]) != 5 or any(
        not isinstance(v, int) or v < 0 for v in tick["activity"]
    ):
        raise ValueError("Invalid activity buckets")
    if tick["flags"]["pointer"] not in ("trackpad", "mouse"):
        raise ValueError("Invalid pointer")
    for field in ("secure_input", "late", "clock_skew"):
        if type(tick["flags"][field]) is not bool:
            raise ValueError("Invalid boolean flag")
    for field in ("injected", "idle_s"):
        if not finite_number(tick["flags"][field]) or tick["flags"][field] < 0:
            raise ValueError("Invalid numeric flag")
    json.dumps(tick, allow_nan=False)
    return tick


class Recorder:
    def __init__(self, path, header):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = __import__("os").open(
            path,
            __import__("os").O_CREAT
            | __import__("os").O_EXCL
            | __import__("os").O_WRONLY,
            0o600,
        )
        self.file = __import__("os").fdopen(fd, "w")
        self.last_t = 0
        self.write(header)

    def write(self, event):
        event = dict(event)
        if "t_ns" in event:
            event["t_ns"] = max(event["t_ns"], self.last_t)
            self.last_t = event["t_ns"]
        self.file.write(json.dumps(local_event(event), allow_nan=False) + "\n")
        self.file.flush()

    def close(self):
        self.file.close()
