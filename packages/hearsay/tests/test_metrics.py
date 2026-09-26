import math
import random

import pytest
from hearsay.metrics import Costs, det_curve, direction_check, eer, min_dcf


@pytest.mark.parametrize("prior", [0.05, 0.3])
def test_perfect_and_reversed(prior):
    costs = Costs(prior, 4, 1)
    assert min_dcf([-2, -1], [1, 2], costs) == 0
    assert min_dcf([1, 2], [-2, -1], costs) == 1
    assert eer([-2, -1], [1, 2]) == 0
    assert eer([1, 2], [-2, -1]) == 1


def test_min_dcf_matches_brute_force_thresholds():
    rng = random.Random(42)
    for _ in range(30):
        real = [rng.gauss(0, 1) for _ in range(37)]
        synth = [rng.gauss(1, 1) for _ in range(19)]
        for prior in (0.05, 0.3):
            costs = Costs(prior, 4, 1)
            candidates = [-math.inf, *real, *synth, math.inf]
            expected = min(
                (
                    4 * (1 - prior) * sum(s >= t for s in real) / len(real)
                    + prior * sum(s < t for s in synth) / len(synth)
                )
                / min(4 * (1 - prior), prior)
                for t in candidates
            )
            assert min_dcf(real, synth, costs) == pytest.approx(expected)


def test_reference_tie_order():
    frr, far, _ = det_curve([0, 0], [0, 0])
    assert frr == [0, 0.5, 1, 1, 1]
    assert far == [1, 1, 1, 0.5, 0]
    assert min_dcf([0, 0], [0, 0], Costs(0.05, 4, 1)) == 1


@pytest.mark.parametrize("real,synth", [([], [1]), ([1], []), ([math.nan], [1]), ([1], [math.inf])])
def test_invalid_scores(real, synth):
    with pytest.raises(ValueError):
        min_dcf(real, synth, Costs(0.05, 4, 1))


@pytest.mark.parametrize("args", [(0, 4, 1), (1, 4, 1), (0.3, 0, 1), (0.3, 4, math.nan)])
def test_invalid_costs(args):
    with pytest.raises(ValueError):
        Costs(*args)


def test_direction_requires_twenty_of_each_and_detects_inversion():
    assert direction_check([-1] * 20, [1] * 20)["auc"] == 1
    for real, synth in [([-1] * 19, [1] * 20), ([1] * 20, [-1] * 20), ([0] * 20, [0] * 20)]:
        with pytest.raises(ValueError):
            direction_check(real, synth)
