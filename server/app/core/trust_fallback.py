"""Reference TrustEngine implementing §5.4 verbatim. Used only when `twobme_ml.trust` isn't installed
(e.g. before the ws-signals merge). Codex 1's `twobme_ml.trust.TrustEngine` is the real engine;
`load_trust_engine_cls()` prefers it.
"""

from __future__ import annotations

import math
from typing import Any

from twobme_common.config import TrustConfig, load_trust_config, logit, sigmoid
from twobme_common.types import BlockScore, ModalityContribution, TrustState


class TrustEngine:
    def __init__(self, cfg: TrustConfig | None = None, p0: float = 0.97, t0: float | None = None):
        self.cfg = cfg or load_trust_config()
        self.L = self._clamp(logit(p0))
        self.t_prev = t0

    # --- helpers -----------------------------------------------------------------------------
    def _clamp(self, L: float) -> float:
        c = self.cfg.logit_cap
        return max(-c, min(c, L))

    def f(self, x: float) -> float:
        C, D, B = self.cfg.squash.C, self.cfg.squash.D, self.cfg.squash.B
        z = -x / B
        e = math.exp(z) if z < 700 else math.inf
        return min(-D + D * (1 + 1 / C) / (1 / C + e), C)

    def llr(self, s: BlockScore) -> float:
        clip = self.cfg.llr.clip
        if s.llr_direct is not None:
            v = s.llr_direct
        elif s.typicality is None:
            return 0.0
        else:
            beta = self.cfg.beta(s.modality)
            t = min(s.typicality, self.cfg.llr.t_max)
            v = -math.log(beta) - (beta - 1) * math.log(1 - t)
        return max(-clip, min(clip, v))

    def band(self, conf: float) -> str:
        if conf >= self.cfg.levels.normal:
            return "normal"
        if conf >= self.cfg.levels.watch:
            return "watch"
        return "suspicious"

    # --- API -----------------------------------------------------------------------------------
    def decay(self, t_end: float, idle_s: float) -> None:
        """Idle hazard first (one-way: waiting never raises trust)."""
        if self.t_prev is None:
            self.t_prev = t_end
            return
        dt = max(0.0, t_end - self.t_prev)
        ic = self.cfg.idle
        idle_part = min(max(idle_s - ic.grace_s, 0.0), dt)
        if dt > ic.gap_s:
            idle_part = max(idle_part, dt - ic.grace_s)
        idle_part = min(max(idle_part, 0.0), dt)
        keep = 2.0 ** -(idle_part / ic.half_life_idle_s + (dt - idle_part) / ic.half_life_active_s)
        p = sigmoid(self.L) * keep
        p = min(max(p, 1e-12), 1 - 1e-12)
        self.L = self._clamp(logit(p))
        self.t_prev = max(self.t_prev, t_end)

    def on_tick(self, t_end: float, idle_s: float, scores: list[BlockScore]) -> TrustState:
        L0 = self.L
        self.decay(t_end, idle_s)
        per: dict[str, ModalityContribution] = {}
        dL = 0.0
        for s in scores:
            w = self.cfg.weights.get(s.modality, 0.0)
            q = min(1.0, s.n / self.cfg.n_ref[s.modality])
            llr = self.llr(s)
            d = self.cfg.kappa * w * q * self.f(llr)
            dL += d
            prev = per.get(s.modality)
            if prev is None:
                per[s.modality] = ModalityContribution(typicality=s.typicality, llr=llr, q=q, w=w, delta=d, n_blocks=1)
            else:
                per[s.modality] = ModalityContribution(
                    typicality=s.typicality, llr=prev.llr + llr, q=max(prev.q, q), w=w, delta=prev.delta + d,
                    n_blocks=prev.n_blocks + 1,
                )
        self.L = self._clamp(self.L + dL)
        return self.state(t_end, self.L - L0, per)

    def state(self, t: float, delta: float = 0.0, per: dict | None = None, reasons: list[str] | None = None) -> TrustState:
        conf = sigmoid(self.L)
        return TrustState(
            t=t, logit=self.L, delta_logit=delta, confidence=conf, display=min(99, round(100 * conf)),
            level=self.band(conf), per_modality=per or {}, reasons=reasons or [],
        )

    def anchor(self, p: float) -> None:
        self.L = self._clamp(logit(p))

    def to_dict(self) -> dict[str, Any]:
        return {"engine": "fallback", "L": self.L, "t_prev": self.t_prev}

    @classmethod
    def from_dict(cls, d: dict[str, Any], cfg: TrustConfig | None = None) -> TrustEngine:
        e = cls(cfg)
        e.L = e._clamp(float(d.get("L", e.L)))
        e.t_prev = d.get("t_prev")
        return e


def load_trust_engine_cls() -> tuple[type, str]:
    try:
        from twobme_ml.trust import TrustEngine as MlTrustEngine  # type: ignore[import-not-found]

        return MlTrustEngine, "twobme_ml"
    except Exception:
        return TrustEngine, "fallback"
