"""STUB (A0) — owner: Codex 2 after CP0. The real `score_audio` wraps hearsay (DF_Arena + DSP)."""

from __future__ import annotations

from typing import Any, Literal

from twobme_common.types import CMResult


def score_audio(x: Any, sr: int, profile: Literal["stepup", "hearsay"]) -> CMResult:
    return CMResult(margin=0.0, p_spoof=None, llr=None, analyzers={}, ms={"total": 0.0})
