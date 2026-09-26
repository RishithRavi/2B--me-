"""Contract config loaders (§5.4) and the env settings shared by agent + server (§5.7).

    cfg = load_trust_config()             # contracts/trust_config.yaml (+ n_ref from the spec)
    cfg = load_trust_config(tuned=True)   # prefers trust_config.tuned.yaml when present
"""

from __future__ import annotations

import math
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from twobme_common.paths import contracts_dir
from twobme_common.spec import MODALITIES, load_spec


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Anchors(_M):
    verify: float
    reset: float
    model_activate: float
    screen_unlock: float
    remote: float
    restart_stale: float
    new_device_enroll: float
    new_device_monitor: float
    rearm_default: float


class IdleCfg(_M):
    grace_s: float
    gap_s: float
    half_life_idle_s: float
    half_life_active_s: float


class LlrCfg(_M):
    clip: float
    t_max: float
    beta_default: float
    beta: dict[str, float]


class SquashCfg(_M):
    C: float
    D: float
    B: float


class LevelsCfg(_M):
    normal: float
    watch: float


class ArmingCfg(_M):
    threshold: float
    consecutive_ticks: int
    rearm_above: float
    cooldown_s: float
    proactive_expiry_s: float


class TierCfg(_M):
    min_conf: float
    actions: tuple[str, ...] = ()
    purchase_below_cents: int | None = None


class PolicyCfg(_M):
    tiers: dict[str, TierCfg]
    trans_status: dict[str, str]
    checkout_badge_min: float


class ResolutionCfg(_M):
    verify_window_s: float
    mfa_timeout_s: float


class ChallengeCfg(_M):
    one_open_per_device: bool
    unlock_max_per_window: int
    unlock_window_s: float
    gray_zone_max_retries: int


class BindingCfg(_M):
    heartbeat_max_s: float
    window_s: int
    lags_s: tuple[int, ...]
    min_pearson: float
    min_active_s: int
    count_ratio: float
    count_ratio_frac: float


class UpdateCandidateCfg(_M):
    min_conf: float
    window_s: float
    min_llr: float
    post_verify_s: float


class SessionCfg(_M):
    end_after_ws_close_s: float
    resume_max_s: float


class HubCfg(_M):
    late_drop_s: float
    clock_skew_s: float


class TrustConfig(_M):
    version: int
    cap: float
    anchors: Anchors
    restart_stale_s: float
    idle: IdleCfg
    llr: LlrCfg
    squash: SquashCfg
    kappa: float
    weights: dict[str, float]
    levels: LevelsCfg
    arming: ArmingCfg
    policy: PolicyCfg
    resolution: ResolutionCfg
    challenge: ChallengeCfg
    binding: BindingCfg
    update_candidate: UpdateCandidateCfg
    session: SessionCfg
    hub: HubCfg
    # merged from feature_spec.yaml
    n_ref: dict[str, int] = Field(default_factory=dict)

    @property
    def logit_cap(self) -> float:
        return logit(self.cap)

    def beta(self, modality: str) -> float:
        return self.llr.beta.get(modality, self.llr.beta_default)


def logit(p: float) -> float:
    return math.log(p / (1.0 - p))


def sigmoid(x: float) -> float:
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    e = math.exp(x)
    return e / (1.0 + e)


def parse_trust_config(raw: dict[str, Any]) -> TrustConfig:
    spec = load_spec()
    raw = dict(raw)
    raw.setdefault("n_ref", {m: spec.n_ref(m) for m in MODALITIES})
    cfg = TrustConfig.model_validate(raw)
    for m in MODALITIES:
        if m not in cfg.weights or m not in cfg.llr.beta:
            raise ValueError(f"trust_config missing weight/beta for {m}")
    return cfg


@lru_cache(maxsize=4)
def load_trust_config(path: str | None = None, tuned: bool = False) -> TrustConfig:
    if path:
        p = Path(path)
    else:
        d = contracts_dir()
        p = d / "trust_config.tuned.yaml" if tuned and (d / "trust_config.tuned.yaml").is_file() else d / "trust_config.yaml"
    with open(p, encoding="utf-8") as fh:
        return parse_trust_config(yaml.safe_load(fh))


class CommonSettings(BaseSettings):
    """Env shared by agent and server. Server-only settings live in server/app/config.py."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    twobme_api: str = "https://2bme.tech"
    model_dir: str = "data/models"
    data_dir: str = "data"
    demo_mode: bool = True
