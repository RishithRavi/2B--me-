"""Locate the repo's contracts/ directory (env override, then walk up from this file / cwd)."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=1)
def contracts_dir() -> Path:
    env = os.environ.get("TWOBME_CONTRACTS_DIR")
    if env:
        p = Path(env)
        if (p / "feature_spec.yaml").is_file():
            return p
        raise FileNotFoundError(f"TWOBME_CONTRACTS_DIR={env} has no feature_spec.yaml")
    for start in (Path(__file__).resolve(), Path.cwd().resolve()):
        for d in (start, *start.parents):
            cand = d / "contracts"
            if (cand / "feature_spec.yaml").is_file():
                return cand
    raise FileNotFoundError("contracts/feature_spec.yaml not found; set TWOBME_CONTRACTS_DIR")
