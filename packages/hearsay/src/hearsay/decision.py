"""Pure decision rules; no trust, lock, session or database effects.

The server remains responsible for computing every score, expiry/attempt
validation, audio deletion and passing shared DTOs to core.events.voice_decided.
"""

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Thresholds:
    """Required calibrated values; deliberately no production defaults."""

    asv_low: float
    asv_high: float
    cm: float
    spectral: float

    def __post_init__(self):
        if not all(math.isfinite(v) for v in (self.asv_low, self.asv_high, self.cm, self.spectral)):
            raise ValueError("thresholds must be finite")
        if not -1 <= self.asv_low < self.asv_high <= 1:
            raise ValueError("ASV thresholds must be ordered cosine values")
        if not 0 < self.cm <= 1 or not -1 <= self.spectral <= 1:
            raise ValueError("invalid CM probability or spectral cosine threshold")


def _valid(value, low, high):
    return value is not None and math.isfinite(value) and low <= value <= high


def decide(
    *,
    thresholds: Thresholds,
    speech_s: float,
    cm_p_spoof: float | None,
    phrase_ok: bool,
    asv_cos: float | None,
    spec_sim: float | None,
    onset_ms: int | None,
    attempt: int,
    trigger: str,
) -> str:
    if attempt not in (1, 2, 3):
        raise ValueError("attempt must be 1, 2 or 3")
    if trigger not in {"proactive", "step_up", "unlock", "redteam", "sandbox"}:
        raise ValueError("unknown challenge trigger")
    retry = "FALLBACK_MFA" if attempt == 3 else "RETRY"
    # §11.2 explicitly requires spoof detection to beat every RETRY gate.
    if _valid(cm_p_spoof, 0, 1) and cm_p_spoof >= thresholds.cm:
        return "BLOCK_SPOOF"
    if not _valid(speech_s, 0, math.inf):
        return "FALLBACK_MFA"
    if speech_s < 1:
        return retry
    if not _valid(cm_p_spoof, 0, 1):
        return "FALLBACK_MFA"
    if not phrase_ok:
        return retry
    if not _valid(asv_cos, -1, 1):
        return "FALLBACK_MFA"
    if trigger == "unlock" and (
        thresholds.cm - 0.15 <= cm_p_spoof < thresholds.cm
        or thresholds.asv_low < asv_cos < thresholds.asv_high
    ):
        return retry
    if asv_cos <= thresholds.asv_low:
        return "BLOCK_IMPOSTOR"
    if not _valid(onset_ms, 0, 6000):
        return retry
    if not _valid(spec_sim, -1, 1):
        return "FALLBACK_MFA"
    if asv_cos >= thresholds.asv_high and spec_sim >= thresholds.spectral:
        return "VERIFY"
    return "FALLBACK_MFA"
