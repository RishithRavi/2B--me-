"""Co-presence (§5.3, P0): is this browser session being driven from the monitored laptop?

co-present ⇔ over the last `window_s` seconds, at some lag ∈ {−1, 0, +1} s:
  pearson(browser, agent activity) ≥ 0.5 over ≥ 5 browser-active seconds, AND
  agent count ≥ 0.8 × browser count in ≥ 80% of browser-active seconds.
Otherwise remote (→ confidence 0.30, the goal's "31%" case).

The window ends at the latest second both sides have reported (agent activity arrives with the
5 s tick). Stickiness: a positive result holds for `sticky_s` unless a decisive negative
(≥ 5 browser-active seconds that fail) arrives — a stolen remote cookie never gets a positive.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

from twobme_common.config import BindingCfg


def pearson(x: list[float], y: list[float]) -> float | None:
    n = len(x)
    if n < 3:
        return None
    mx, my = sum(x) / n, sum(y) / n
    sxx = sum((a - mx) ** 2 for a in x)
    syy = sum((b - my) ** 2 for b in y)
    if sxx <= 0 or syy <= 0:
        return None
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y, strict=True))
    return sxy / math.sqrt(sxx * syy)


@dataclass
class PresenceEval:
    binding: str               # co-present | remote
    score: float | None
    active_s: int
    decisive: bool


def evaluate(browser: dict[int, int], agent: dict[int, int], cfg: BindingCfg,
             end_s: int | None = None) -> PresenceEval:
    if not browser or not agent:
        return PresenceEval("remote", None, 0, False)
    end = end_s if end_s is not None else min(max(browser), max(agent) - max(cfg.lags_s))
    secs = list(range(end - cfg.window_s + 1, end + 1))
    b = [float(browser.get(t, 0)) for t in secs]
    active = [i for i, v in enumerate(b) if v > 0]
    if len(active) < cfg.min_active_s:
        return PresenceEval("remote", None, len(active), False)
    best: float | None = None
    for lag in cfg.lags_s:
        a = [float(agent.get(t + lag, 0)) for t in secs]
        r = pearson(b, a)
        if r is None:
            continue
        ok_frac = sum(1 for i in active if a[i] >= cfg.count_ratio * b[i]) / len(active)
        best = r if best is None else max(best, r)
        if r >= cfg.min_pearson and ok_frac >= cfg.count_ratio_frac:
            return PresenceEval("co-present", r, len(active), True)
    return PresenceEval("remote", best, len(active), True)


@dataclass
class PresenceTracker:
    """Per web-session browser buckets + sticky binding state."""

    cfg: BindingCfg
    sticky_s: float = 60.0
    buckets: dict[int, int] = field(default_factory=dict)
    offset_s: float = 0.0          # server_now − client_now
    last_positive: float | None = None
    last: PresenceEval | None = None

    def add(self, buckets: list[tuple[int, int]], client_now_ms: int | None) -> None:
        if client_now_ms is not None:
            off = time.time() - client_now_ms / 1000.0
            self.offset_s = off if self.last is None else 0.7 * self.offset_s + 0.3 * off
        shift = round(self.offset_s)
        for t_s, n in buckets:
            self.buckets[t_s + shift] = n
        cutoff = int(time.time()) - 120
        for k in [k for k in self.buckets if k < cutoff]:
            del self.buckets[k]

    def update(self, agent: dict[int, int]) -> PresenceEval:
        ev = evaluate(self.buckets, agent, self.cfg)
        now = time.monotonic()
        if ev.binding == "co-present":
            self.last_positive = now
        elif ev.decisive:
            self.last_positive = None
        self.last = ev
        return ev

    def binding(self) -> tuple[str, float | None]:
        if self.last is not None and self.last.binding == "co-present":
            return "co-present", self.last.score
        if self.last_positive is not None and time.monotonic() - self.last_positive <= self.sticky_s:
            return "co-present", self.last.score if self.last else None
        return "remote", self.last.score if self.last else None
