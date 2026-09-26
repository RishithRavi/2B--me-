"""Detection metrics. Inputs always have larger scores for synthetic speech.

ASVspoof compatibility: negate scores, use bonafide as the positive class,
stable sort (including the reference's tie behavior), and normalize by the
smaller constant-decision cost. No threshold is fitted on a test set.
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class Costs:
    p_synth: float
    cost_real_flagged: float
    cost_synth_missed: float

    def __post_init__(self):
        if not 0 < self.p_synth < 1:
            raise ValueError("p_synth must be strictly between zero and one")
        if any(
            not math.isfinite(c) or c <= 0 for c in (self.cost_real_flagged, self.cost_synth_missed)
        ):
            raise ValueError("costs must be finite and positive")


def det_curve(real: Sequence[float], synth: Sequence[float]):
    """Return (real flagged, synth missed, bona-high threshold) reference curves."""
    if len(real) == 0 or len(synth) == 0:
        raise ValueError("both real and synthetic samples are required")
    trials = [(-float(s), True) for s in real] + [(-float(s), False) for s in synth]
    if any(not math.isfinite(s) for s, _ in trials):
        raise ValueError("scores must be finite")
    trials.sort(key=lambda row: row[0])
    frr, far, thresholds = [0.0], [1.0], [trials[0][0] - 0.001]
    rejected_real = rejected_synth = 0
    for threshold, is_real in trials:
        rejected_real += is_real
        rejected_synth += not is_real
        frr.append(rejected_real / len(real))
        far.append((len(synth) - rejected_synth) / len(synth))
        thresholds.append(threshold)
    return frr, far, thresholds


def min_dcf(real: Sequence[float], synth: Sequence[float], costs: Costs) -> float:
    frr, far, _ = det_curve(real, synth)
    real_weight = (1 - costs.p_synth) * costs.cost_real_flagged
    # Match the reference's (1 - p_target) floating point arithmetic.
    synth_weight = (1 - (1 - costs.p_synth)) * costs.cost_synth_missed
    return min(real_weight * r + synth_weight * s for r, s in zip(frr, far, strict=True)) / min(
        real_weight, synth_weight
    )


def eer(real: Sequence[float], synth: Sequence[float]) -> float:
    frr, far, _ = det_curve(real, synth)
    index = min(range(len(frr)), key=lambda i: abs(frr[i] - far[i]))
    return (frr[index] + far[index]) / 2


def direction_check(real: Sequence[float], synth: Sequence[float], *, minimum=20) -> dict:
    """Smoke check with consented real/ElevenLabs clips, not a model-quality claim."""
    det_curve(real, synth)  # validate scores
    if len(real) < minimum or len(synth) < minimum:
        raise ValueError(f"direction check requires at least {minimum} clips per class")
    auc = sum((s > r) + 0.5 * (s == r) for r in real for s in synth) / (len(real) * len(synth))
    if auc <= 0.5:
        raise ValueError("synthetic-high direction check failed (AUC <= 0.5)")
    return {"direction": "synth_high", "auc": auc, "n_real": len(real), "n_synth": len(synth)}
