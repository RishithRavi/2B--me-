"""Numerical trust state only. Challenges, locks and authorization belong to the hub."""

from __future__ import annotations
from pathlib import Path
import math
import yaml
from twobme_common.types import TrustState, ModalityContribution
from .config import trust_config
from .model import ACTIVE_MODALITIES


def logit(p):
    p = min(1 - 1e-15, max(1e-15, p))
    return math.log(p / (1 - p))


def sigmoid(x):
    return 1 / (1 + math.exp(-max(-700, min(700, x))))


def load_config(path="contracts/trust_config.yaml"):
    with Path(path).open() as f:
        return yaml.safe_load(f)


class TrustEngine:
    def __init__(self, cfg=None, *, initial=0.30):
        self.cfg = trust_config(cfg if cfg is not None else load_config())
        self.L = logit(initial)
        self.t = None
        self._validate()

    def _validate(self):
        # Configuration shape is documented in the integration guide; no beta is read from a model.
        for k in ("cap", "kappa", "C", "D", "B", "weights", "beta", "n_ref"):
            if k not in self.cfg:
                raise ValueError(f"Missing trust setting: {k}")
        if not 0.5 < self.cfg["cap"] < 1:
            raise ValueError("Invalid cap")
        if any(self.cfg[k] <= 0 for k in ("C", "D", "B")):
            raise ValueError("Invalid transform parameters")
        self.limit = logit(self.cfg["cap"])
        self.L = max(-self.limit, min(self.limit, self.L))

    def anchor(self, p):
        if not 0 < p < 1:
            raise ValueError("Anchor must be in (0,1)")
        self.L = max(-self.limit, min(self.limit, logit(p)))

    def on_tick(self, t_end, idle_s, scores):
        if not math.isfinite(t_end) or not math.isfinite(idle_s) or idle_s < 0:
            raise ValueError("Invalid tick time")
        if self.t is not None and t_end < self.t:
            raise ValueError("Out-of-order tick must not be scored")
        dt = 0 if self.t is None else t_end - self.t
        idle = self.cfg.get("idle", {})
        grace = idle.get("grace_s", 60)
        idle_part = min(dt, max(0, idle_s - grace))
        if dt > idle.get("gap_s", 15):
            idle_part = max(idle_part, dt - grace)
        keep = 2 ** (-(idle_part / idle.get("half_life_idle_s", 600)
                      + (dt - idle_part) / idle.get("half_life_active_s", 14400)))
        before = self.L
        self.L = logit(sigmoid(self.L) * keep)
        contributions = {}
        for s in scores:
            m = s.modality
            if m not in ACTIVE_MODALITIES:
                continue
            if s.typicality is None and s.llr_direct is None:
                continue
            if s.n <= 0:
                continue
            beta = float(self.cfg["beta"][m])
            if beta <= 0:
                raise ValueError("Beta must be positive")
            t = s.typicality
            if t is not None and (not math.isfinite(t) or not 0 <= t <= 1):
                raise ValueError("Invalid typicality")
            llr = (
                s.llr_direct
                if s.llr_direct is not None
                else -math.log(beta) - (beta - 1) * math.log1p(-min(t, self.cfg.get("llr", {}).get("t_max", 1 - 1e-6)))
            )
            if not math.isfinite(llr):
                raise ValueError("Nonfinite LLR")
            clip = self.cfg.get("llr", {}).get("clip", 4)
            llr = max(-clip, min(clip, llr))
            q = min(1, s.n / self.cfg["n_ref"][m])
            w = self.cfg["weights"][m]
            C, D, B = (self.cfg[k] for k in ("C", "D", "B"))
            f = min(-D + D * (1 + 1 / C) / (1 / C + math.exp(-llr / B)), C)
            delta = self.cfg["kappa"] * w * q * f
            self.L += delta
            if m not in contributions:
                contributions[m] = {
                    "typicality": t,
                    "llr": llr,
                    "q": q,
                    "w": w,
                    "delta": delta,
                    "n_blocks": 1,
                }
            else:
                a = contributions[m]
                n = a["n_blocks"]
                a["llr"] = (a["llr"] * n + llr) / (n + 1)
                a["q"] = (a["q"] * n + q) / (n + 1)
                a["delta"] += delta
                a["n_blocks"] += 1
        self.L = max(-self.limit, min(self.limit, self.L))
        self.t = t_end
        p = sigmoid(self.L)
        return TrustState(
            t=t_end,
            logit=self.L,
            delta_logit=self.L - before,
            confidence=p,
            display=min(99, round(100 * p)),
            level="normal" if p >= self.cfg.get("levels", {}).get("normal", 0.8)
            else "watch" if p >= self.cfg.get("levels", {}).get("watch", 0.4) else "suspicious",
            per_modality={
                k: ModalityContribution(**v) for k, v in contributions.items()
            },
            reasons=["idle_decay"] if idle_part else [],
        )

    def to_dict(self):
        return {"version": 1, "logit": self.L, "t": self.t, "config": self.cfg}

    @classmethod
    def from_dict(cls, d, cfg=None):
        if d.get("version") != 1:
            raise ValueError("Unknown trust state version")
        obj = cls(cfg if cfg is not None else d["config"])
        obj.L = float(d["logit"])
        obj.t = d["t"]
        if not math.isfinite(obj.L):
            raise ValueError("Invalid persisted logit")
        obj._validate()
        return obj
