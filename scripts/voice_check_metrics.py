"""Compare against a local copy of official ASVspoof5 calculate_modules.py.

Download the reference separately; this check never uses the network. Only the
two evaluation functions are compiled, not the reference module's other code.
"""

import argparse
import ast
import hashlib
import json
from pathlib import Path

import numpy as np
from hearsay.metrics import Costs, det_curve, min_dcf


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", type=Path, required=True)
    args = parser.parse_args()
    source = args.reference.read_bytes()
    module = ast.parse(source)
    names = {"compute_det_curve", "compute_mindcf"}
    functions = [
        node for node in module.body if isinstance(node, ast.FunctionDef) and node.name in names
    ]
    if {node.name for node in functions} != names:
        raise ValueError("reference is missing required official functions")
    namespace = {"np": np}
    # Explicit developer-supplied reference, restricted to its two metric functions.
    exec(  # noqa: S102
        compile(ast.Module(body=functions, type_ignores=[]), str(args.reference), "exec"),
        namespace,
    )
    rng = np.random.default_rng(20260926)
    cases = [([-2, -1], [1, 2]), ([1, 2], [-2, -1]), ([0, 0], [0, 0])]
    for _ in range(100):
        real, synth = rng.normal(size=37), rng.normal(0.5, 1, size=19)
        cases.extend([(real, synth), (real.round(1), synth.round(1))])
    for real, synth in cases:
        ref = namespace["compute_det_curve"](-np.asarray(real), -np.asarray(synth))
        for actual, expected in zip(det_curve(real, synth), ref, strict=True):
            np.testing.assert_allclose(actual, expected, atol=1e-14, rtol=0)
        for prior in (0.05, 0.3):
            expected, _ = namespace["compute_mindcf"](*ref, prior, 4, 1)
            actual = min_dcf(real, synth, Costs(prior, 4, 1))
            np.testing.assert_allclose(actual, expected, atol=1e-14, rtol=0)
    print(
        json.dumps(
            {
                "cases": len(cases),
                "cost_settings": 2,
                "status": "passed",
                "reference_sha256": hashlib.sha256(source).hexdigest(),
            }
        )
    )


if __name__ == "__main__":
    main()
