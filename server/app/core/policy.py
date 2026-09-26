"""Risk policy (§5.4): tier × confidence → allow / step_up / block. Pure functions.

block only when the device is locked. Behavior alone never blocks.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from twobme_common.config import TrustConfig


@dataclass(frozen=True)
class PolicyResult:
    tier: str
    decision: str          # allow | step_up | block
    trans_status: str      # Y | C | N
    min_conf: float
    reasons: list[str] = field(default_factory=list)


def tier_for(cfg: TrustConfig, action: str, amount_cents: int | None) -> str:
    if action == "purchase":
        amt = amount_cents or 0
        r1 = cfg.policy.tiers["R1"].purchase_below_cents or 10_000
        r2 = cfg.policy.tiers["R2"].purchase_below_cents or 50_000
        if amt < r1:
            return "R1"
        if amt < r2:
            return "R2"
        return "R3"
    for name, tier in cfg.policy.tiers.items():
        if action in tier.actions:
            return name
    return "R3"  # unknown actions are treated as highest risk


def evaluate(cfg: TrustConfig, *, action: str, amount_cents: int | None, confidence: float,
             locked: bool, learning: bool) -> PolicyResult:
    tier = tier_for(cfg, action, amount_cents)
    min_conf = cfg.policy.tiers[tier].min_conf
    ts = cfg.policy.trans_status
    if locked:
        return PolicyResult(tier, "block", ts["block"], min_conf, ["device_locked"])
    if learning and tier == "R3":
        return PolicyResult(tier, "step_up", ts["step_up"], min_conf, ["learning_mode_r3"])
    if confidence >= min_conf:
        return PolicyResult(tier, "allow", ts["allow"], min_conf, [f"confidence {confidence:.2f} ≥ {min_conf:.2f}"])
    return PolicyResult(tier, "step_up", ts["step_up"], min_conf, [f"confidence {confidence:.2f} < {min_conf:.2f}"])
