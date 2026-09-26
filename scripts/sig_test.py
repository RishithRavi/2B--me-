#!/usr/bin/env python3
"""Run the signals suite; test DTO shim is used only before CP0 exists."""

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
for p in ["packages/common", "packages/features", "packages/ml", "agent", "scripts"]:
    sys.path.insert(0, str(ROOT / p))
from sig_test_contracts import install

install()
import pytest

raise SystemExit(
    pytest.main(
        [
            str(ROOT / "packages/features/tests"),
            str(ROOT / "packages/ml/tests"),
            str(ROOT / "agent/tests"),
            *sys.argv[1:],
        ]
    )
)
