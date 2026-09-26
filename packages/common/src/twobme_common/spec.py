"""Feature spec v1 loader (§5.1). `contracts/feature_spec.yaml` is the only ordering source.

    spec = load_spec()
    spec.names("keyboard")                 # canonical order
    spec.vectorize("keyboard", features)   # dict -> list[float|None] (DB real[])
    spec.devectorize("keyboard", vec)      # list -> dict; NaN/inf -> None
    spec.headline_columns()                # [(feature, column)], exactly 15
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, PrivateAttr

from twobme_common.paths import contracts_dir

MODALITIES: tuple[str, ...] = ("keyboard", "mouse", "scroll", "workflow", "temporal")


class FeatureDef(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    name: str
    unit: str
    label: str
    headline: bool = False
    derived: Literal["model"] | None = None

    @property
    def column(self) -> str:
        return headline_column(self.name)


class ModalitySpec(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    n_unit: str
    n_ref: int
    close: dict[str, float]
    enroll_gate: int
    features: tuple[FeatureDef, ...]
    psd: dict[str, float] | None = None


def headline_column(name: str) -> str:
    return name.lower().replace(".", "_")


def _clean(x: Any) -> float | None:
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


class FeatureSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    schema_version: int
    enums: dict[str, tuple[str, ...]]
    tick: dict[str, float]
    modalities: dict[str, ModalitySpec]
    signature: dict[str, dict[str, tuple[str, ...]]]
    _idx: dict[str, tuple[str, FeatureDef]] = PrivateAttr(default_factory=dict)

    def model_post_init(self, _ctx: Any) -> None:
        self._idx.update({f.name: (m, f) for m, ms in self.modalities.items() for f in ms.features})

    # --- ordering -----------------------------------------------------------
    def names(self, modality: str) -> list[str]:
        return [f.name for f in self.modalities[modality].features]

    def feature(self, name: str) -> FeatureDef:
        return self._idx[name][1]

    def modality_of(self, name: str) -> str:
        return self._idx[name][0]

    def label(self, name: str) -> str:
        return self.feature(name).label

    def unit(self, name: str) -> str:
        return self.feature(name).unit

    def n_ref(self, modality: str) -> int:
        return self.modalities[modality].n_ref

    # --- vectors ------------------------------------------------------------
    def vectorize(self, modality: str, features: Mapping[str, Any]) -> list[float | None]:
        """Dict -> list in canonical order. Missing, NaN or inf -> None. Unknown keys raise."""
        names = self.names(modality)
        extra = set(features) - set(names)
        if extra:
            raise KeyError(f"unknown {modality} features: {sorted(extra)}")
        return [_clean(features.get(n)) for n in names]

    def devectorize(self, modality: str, vec: Sequence[Any]) -> dict[str, float | None]:
        names = self.names(modality)
        if len(vec) != len(names):
            raise ValueError(f"{modality}: expected {len(names)} values, got {len(vec)}")
        return {n: _clean(v) for n, v in zip(names, vec, strict=True)}

    def check_features(self, modality: str, features: Mapping[str, Any]) -> None:
        """Wire rule: the dict carries EXACTLY names(modality)."""
        names = set(self.names(modality))
        got = set(features)
        if got != names:
            raise ValueError(
                f"{modality} features mismatch: missing={sorted(names - got)} unknown={sorted(got - names)}"
            )

    # --- headline -----------------------------------------------------------
    def headline_columns(self) -> list[tuple[str, str]]:
        return [
            (f.name, f.column)
            for m in MODALITIES
            for f in self.modalities[m].features
            if f.headline
        ]

    def headline_values(self, modality: str, features: Mapping[str, Any]) -> dict[str, float | None]:
        return {f.column: _clean(features.get(f.name)) for f in self.modalities[modality].features if f.headline}

    # --- signature traceability (§5.1.8) --------------------------------------
    def signature_features(self, modality: str, leaf: str) -> list[str]:
        out: list[str] = []
        names = self.names(modality)
        for pat in self.signature[modality][leaf]:
            if pat.endswith("*"):
                out.extend(n for n in names if n.startswith(pat[:-1]))
            elif pat in names:
                out.append(pat)
            else:
                raise KeyError(f"signature {modality}/{leaf}: unknown feature {pat}")
        return out



def parse_spec(raw: Mapping[str, Any]) -> FeatureSpec:
    spec = FeatureSpec.model_validate(raw)
    if tuple(spec.modalities) != MODALITIES:
        raise ValueError(f"modalities must be exactly {MODALITIES} in order")
    seen: set[str] = set()
    for m, ms in spec.modalities.items():
        prefix = {"keyboard": "kb.", "mouse": "ms.", "scroll": "sc.", "workflow": "wf.", "temporal": "tp."}[m]
        for f in ms.features:
            if not f.name.startswith(prefix):
                raise ValueError(f"{f.name} must start with {prefix}")
            if f.name in seen:
                raise ValueError(f"duplicate feature {f.name}")
            seen.add(f.name)
    cols = [c for _, c in spec.headline_columns()]
    if len(cols) != 15 or len(set(cols)) != 15:
        raise ValueError(f"expected exactly 15 unique headline columns, got {cols}")
    return spec


@lru_cache(maxsize=4)
def load_spec(path: str | None = None) -> FeatureSpec:
    p = Path(path) if path else contracts_dir() / "feature_spec.yaml"
    with open(p, encoding="utf-8") as fh:
        return parse_spec(yaml.safe_load(fh))
