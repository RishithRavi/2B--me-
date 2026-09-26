#!/usr/bin/env python3
"""Seeded two-person behavior simulator for model development. SYNTHETIC ONLY.

Generates class-level event logs (§5.1.7) for an owner A (three sessions) and a short
impostor B session on the "same laptop". Both people cycle through the same shared
contexts (write, browse, read, code), so context is nuisance variation the one-class
model has to tolerate, while identity lives in person-level timing, pointer, scroll and
workflow habits. `similarity` shrinks B's habits toward A's: 0 = identical people,
1 = two independent draws from the population.

This validates relative model changes through the real feature extractor. It is never
evidence about real people and must never enter an owner's baseline.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

DISPLAY = {"w_pt": 1512, "h_pt": 982, "hz": 120}
# Same laptop for both people: report rates are device properties, not habits.
MOUSE_HZ, SCROLL_HZ = 120.0, 90.0
CATS = ["browser", "ide", "terminal", "chat", "docs", "media", "system", "other"]

# Population of habits: name -> (population mean, between-person sd). Log-scale entries
# are natural logs of ms / pt / counts; the rest are probabilities or plain values.
POPULATION = {
    # keyboard
    "hold_L": (math.log(95), 0.16), "hold_R": (math.log(95), 0.16),
    "hold_space": (math.log(105), 0.18), "hold_bksp": (math.log(90), 0.18),
    "hold_sigma": (0.22, 0.05),
    "fl_same": (math.log(185), 0.25), "fl_cross": (math.log(150), 0.25),
    "fl_l_space": (math.log(160), 0.25), "fl_space_l": (math.log(210), 0.28),
    "fl_sigma": (0.38, 0.08),
    "think_p": (0.06, 0.03), "think_mu": (math.log(1600), 0.35),
    "typo_p": (0.045, 0.02), "notice_mu": (math.log(320), 0.30),
    "bksp_extra": (0.6, 0.4), "bksp_fl_mu": (math.log(140), 0.25),
    "shift_p": (0.12, 0.06), "shift_lead_mu": (math.log(140), 0.30),
    "chord_p": (0.04, 0.02), "word_len": (4.6, 0.5), "words_burst": (5.0, 2.0),
    # mouse (trackpad)
    "fitts_a": (0.20, 0.05), "fitts_b": (0.14, 0.035), "peak_frac": (0.42, 0.06),
    "curve_amp": (0.06, 0.03), "submove_p": (0.25, 0.12), "dist_mu": (math.log(240), 0.25),
    "pc_p": (0.55, 0.12), "dd_p": (0.06, 0.04), "pre_click_mu": (math.log(170), 0.35),
    "click_hold_mu": (math.log(95), 0.22), "dbl_p": (0.07, 0.05), "dbl_mu": (math.log(170), 0.20),
    "hover_p": (0.18, 0.10), "jitter": (0.6, 0.3),
    # scroll
    "sc_events": (math.log(14), 0.35), "sc_step": (math.log(5.0), 0.35),
    "momentum_p": (0.45, 0.25), "reversal_p": (0.10, 0.07),
    "horiz": (0.04, 0.03), "sc_gap_mu": (math.log(900), 0.40),
    # workflow
    "switch_per_min": (0.45, 0.15), "cmdtab_p": (0.45, 0.25), "window_per_min": (0.30, 0.12),
    "tab_chord_p": (0.30, 0.20), "latency_mu": (math.log(700), 0.35),
    # activity pacing / idle
    "gap_mu": (math.log(450), 0.30), "idle_p": (0.05, 0.03), "idle_mu": (math.log(4000), 0.4),
}
PROBS = {"think_p", "typo_p", "shift_p", "chord_p", "submove_p", "pc_p", "dd_p", "dbl_p",
         "hover_p", "momentum_p", "reversal_p", "horiz", "cmdtab_p", "tab_chord_p", "idle_p"}

# Shared contexts: activity mix (type, mouse, scroll, idle) and small shared habit shifts.
CONTEXTS = {
    "write":  {"mix": [0.62, 0.20, 0.08, 0.10], "fl": 0.00, "typo": 1.0, "chord": 0.6},
    "browse": {"mix": [0.12, 0.50, 0.28, 0.10], "fl": -0.05, "typo": 0.8, "chord": 1.4},
    "read":   {"mix": [0.05, 0.22, 0.48, 0.25], "fl": 0.05, "typo": 1.0, "chord": 0.8},
    "code":   {"mix": [0.45, 0.30, 0.15, 0.10], "fl": 0.12, "typo": 1.5, "chord": 2.0},
}


def draw_person(rng):
    return {k: rng.normal(mu, sd) for k, (mu, sd) in POPULATION.items()}


def transition_habits(rng, base=None, similarity=1.0):
    """Row-stochastic habit weights over categories; B shrinks toward A's."""
    own = rng.gamma(0.6, 1.0, size=(len(CATS), len(CATS)))
    own[:, 4:] *= 0.25  # docs/media/system/other are rarer for everyone
    return own if base is None else base + similarity * (own - base)


def shrink(a, b, similarity):
    return {k: a[k] + similarity * (b[k] - a[k]) for k in a}


def finalize(p):
    q = dict(p)
    for k in PROBS:
        q[k] = float(np.clip(q[k], 0.002, 0.95))
    q["hold_sigma"] = max(0.08, q["hold_sigma"])
    q["fl_sigma"] = max(0.15, q["fl_sigma"])
    q["bksp_extra"] = max(0.0, q["bksp_extra"])
    q["word_len"] = max(2.5, q["word_len"])
    q["words_burst"] = max(1.5, q["words_burst"])
    q["fitts_a"] = max(0.06, q["fitts_a"])
    q["fitts_b"] = max(0.05, q["fitts_b"])
    q["peak_frac"] = float(np.clip(q["peak_frac"], 0.2, 0.7))
    q["curve_amp"] = max(0.0, q["curve_amp"])
    q["jitter"] = max(0.05, q["jitter"])
    q["switch_per_min"] = max(0.03, q["switch_per_min"])
    q["window_per_min"] = max(0.02, q["window_per_min"])
    return q


class Writer:
    def __init__(self, rng, person, trans):
        self.rng, self.p, self.trans = rng, person, trans
        self.ev = []
        self.slot = 0
        self.x, self.y = 700.0, 450.0
        self.cat = "ide"

    def add(self, t, ev, **kw):
        self.ev.append({"t_ns": int(t * 1e9), "ev": ev, **kw})

    def ln(self, mu, sigma):
        return float(np.exp(self.rng.normal(mu, sigma)))

    # --- keyboard ---------------------------------------------------------------------------
    def key(self, t, cls, hold_mu):
        self.slot += 1
        hold = self.ln(hold_mu, self.p["hold_sigma"]) / 1000
        self.add(t, "key", down=True, slot=self.slot, cls=cls, autorepeat=False, inj=False)
        self.add(t + hold, "key", down=False, slot=self.slot, cls=cls, autorepeat=False, inj=False)
        return hold

    def typing(self, t, ctx, drift):
        p, rng = self.p, self.rng
        fl_shift = ctx["fl"] + drift
        prev = "SPACE"
        for _ in range(max(1, rng.poisson(p["words_burst"]))):
            n = max(1, rng.poisson(p["word_len"] - 1) + 1)
            letters = ["L_LETTER" if rng.random() < 0.57 else "R_LETTER" for _ in range(n)]
            if rng.random() < p["think_p"]:
                t += self.ln(p["think_mu"], 0.4) / 1000
            shift = rng.random() < p["shift_p"]
            i = 0
            while i < len(letters):
                cls = letters[i]
                if prev == "SPACE":
                    mu = p["fl_space_l"]
                elif prev == cls:
                    mu = p["fl_same"]
                elif prev.endswith("LETTER"):
                    mu = p["fl_cross"]
                else:
                    mu = p["fl_cross"] + 0.1
                t += self.ln(mu + fl_shift, p["fl_sigma"]) / 1000
                if shift and i == 0:
                    lead = self.ln(p["shift_lead_mu"], 0.3) / 1000
                    self.slot += 1
                    s = self.slot
                    self.add(t - lead, "key", down=True, slot=900000 + s, cls="SHIFT",
                             autorepeat=False, inj=False)
                    hold = self.key(t, cls, p["hold_L" if cls == "L_LETTER" else "hold_R"])
                    self.add(t + hold + 0.03, "key", down=False, slot=900000 + s, cls="SHIFT",
                             autorepeat=False, inj=False)
                else:
                    self.key(t, cls, p["hold_L" if cls == "L_LETTER" else "hold_R"])
                prev = cls
                if rng.random() < p["typo_p"] * ctx["typo"]:
                    # Notice the slip, delete a short run, then retype it.
                    t += self.ln(p["notice_mu"], 0.35) / 1000
                    k = 1 + rng.poisson(p["bksp_extra"])
                    for j in range(k):
                        if j:
                            t += self.ln(p["bksp_fl_mu"], 0.3) / 1000
                        self.key(t, "BKSP", p["hold_bksp"])
                    prev = "BKSP"
                    i = max(0, i - k + 1)
                    continue
                i += 1
            t += self.ln(p["fl_l_space"] + fl_shift, p["fl_sigma"]) / 1000
            self.key(t, "SPACE", p["hold_space"])
            prev = "SPACE"
            if rng.random() < p["chord_p"] * ctx["chord"]:
                t += self.ln(math.log(400), 0.4) / 1000
                self.add(t, "chord", kind=str(rng.choice(["other_cmd", "tab_new", "tab_cycle"],
                                                         p=[0.6, 0.2, 0.2])))
        return t

    # --- mouse --------------------------------------------------------------------------------
    def stroke(self, t, kind="move"):
        p, rng = self.p, self.rng
        dist = min(self.ln(p["dist_mu"], 0.6), 1100.0)
        ang = rng.uniform(0, 2 * math.pi)
        tx = float(np.clip(self.x + dist * math.cos(ang), 5, DISPLAY["w_pt"] - 5))
        ty = float(np.clip(self.y + dist * math.sin(ang), 5, DISPLAY["h_pt"] - 5))
        dx, dy = tx - self.x, ty - self.y
        d = math.hypot(dx, dy) or 1.0
        width = rng.uniform(18, 60)
        dur = max(0.08, p["fitts_a"] + p["fitts_b"] * math.log2(1 + d / width)) * rng.lognormal(0, 0.15)
        # Asymmetric minimum-jerk profile: warp time so velocity peaks near peak_frac.
        gamma = math.log(0.5) / math.log(p["peak_frac"])
        side = 1 if rng.random() < 0.5 else -1
        amp = p["curve_amp"] * rng.lognormal(0, 0.4) * side
        hover_at = rng.uniform(0.3, 0.8) if rng.random() < p["hover_p"] else None
        dt = 1 / MOUSE_HZ
        s, pause = 0.0, 0.0
        while s <= dur:
            u = (s / dur) ** gamma
            prog = 10 * u**3 - 15 * u**4 + 6 * u**5
            lat = amp * d * math.sin(math.pi * u)
            px = self.x + dx * prog - dy / d * lat + rng.normal(0, p["jitter"])
            py = self.y + dy * prog + dx / d * lat + rng.normal(0, p["jitter"])
            self.add(t + s + pause, "mouse", kind=kind, x_pt=px, y_pt=py, button=0, inj=False)
            if hover_at is not None and u >= hover_at:
                pause += rng.uniform(0.14, 0.26)
                hover_at = None
            s += dt * rng.uniform(0.9, 1.1)
        end = t + dur + pause
        if rng.random() < p["submove_p"]:
            # Corrective sub-movement toward the final target.
            cx, cy = tx + rng.normal(0, 6), ty + rng.normal(0, 6)
            steps = max(4, int(rng.uniform(0.09, 0.2) * MOUSE_HZ))
            for k in range(1, steps + 1):
                u = k / steps
                prog = 10 * u**3 - 15 * u**4 + 6 * u**5
                self.add(end + k * dt, "mouse", kind=kind, x_pt=tx + (cx - tx) * prog,
                         y_pt=ty + (cy - ty) * prog, button=0, inj=False)
            end += steps * dt
            tx, ty = cx, cy
        self.x, self.y = tx, ty
        return end

    def mouse(self, t):
        p, rng = self.p, self.rng
        r = rng.random()
        if r < p["dd_p"]:
            self.add(t, "mouse", kind="down", x_pt=self.x, y_pt=self.y, button=0, inj=False)
            end = self.stroke(t + 0.05, kind="drag")
            self.add(end + 0.03, "mouse", kind="up", x_pt=self.x, y_pt=self.y, button=0, inj=False)
            return end + 0.03
        end = self.stroke(t)
        if r < p["dd_p"] + p["pc_p"]:
            down = end + self.ln(p["pre_click_mu"], 0.35) / 1000
            hold = self.ln(p["click_hold_mu"], 0.22) / 1000
            self.add(down, "mouse", kind="down", x_pt=self.x, y_pt=self.y, button=0, inj=False)
            self.add(down + hold, "mouse", kind="up", x_pt=self.x, y_pt=self.y, button=0, inj=False)
            end = down + hold
            if rng.random() < p["dbl_p"]:
                down = end + self.ln(p["dbl_mu"], 0.2) / 1000 - hold
                hold = self.ln(p["click_hold_mu"], 0.22) / 1000
                self.add(down, "mouse", kind="down", x_pt=self.x, y_pt=self.y, button=0, inj=False)
                self.add(down + hold, "mouse", kind="up", x_pt=self.x, y_pt=self.y, button=0, inj=False)
                end = down + hold
        return end

    # --- scroll -------------------------------------------------------------------------------
    def scroll(self, t):
        p, rng = self.p, self.rng
        n = max(2, int(self.ln(p["sc_events"], 0.45)))
        step = self.ln(p["sc_step"], 0.3)
        sign = 1 if rng.random() < 0.8 else -1
        flip = rng.integers(1, n) if rng.random() < p["reversal_p"] and n > 2 else None
        for k in range(n):
            if flip is not None and k == flip:
                sign = -sign
            prof = math.sin(math.pi * (k + 0.5) / n)
            dy = sign * step * (0.4 + prof) + rng.normal(0, 0.5)
            dx = step * p["horiz"] * rng.normal(0, 1)
            self.add(t, "scroll", dy=float(dy), dx=float(dx), continuous=True, phase=0, momentum=0)
            t += 1 / SCROLL_HZ * rng.uniform(0.8, 1.2)
        if rng.random() < p["momentum_p"]:
            for k in range(int(rng.integers(5, 25))):
                self.add(t + 0.016 * k, "scroll", dy=float(sign * step * 0.9**k), dx=0.0,
                         continuous=True, phase=0, momentum=1)
        return t

    # --- workflow -----------------------------------------------------------------------------
    def switch(self, t):
        p, rng = self.p, self.rng
        row = self.trans[CATS.index(self.cat)].copy()
        row[CATS.index(self.cat)] = 0
        nxt = CATS[int(rng.choice(len(CATS), p=row / row.sum()))]
        via = "cmdtab" if rng.random() < p["cmdtab_p"] else "click"
        if via == "cmdtab":
            self.add(t - 0.05, "chord", kind="app_switch_kbd")
        self.add(t, "app", cat=nxt, via=via)
        if rng.random() < 0.5:
            self.add(t + 0.1, "window")
        self.cat = nxt
        return t + self.ln(p["latency_mu"], 0.4) / 1000

    def window(self, t):
        if self.rng.random() < self.p["tab_chord_p"]:
            self.add(t - 0.05, "chord", kind=str(self.rng.choice(["tab_new", "tab_close", "tab_jump"])))
        self.add(t, "window")
        return t + 0.2

    def phase(self, t, end, ctx, drift):
        p, rng = self.p, self.rng
        mix = np.array(ctx["mix"], float)
        # Workflow events are Poisson in wall time, independent of activity pacing.
        next_switch = t + rng.exponential(60 / p["switch_per_min"])
        next_window = t + rng.exponential(60 / p["window_per_min"])
        while t < end:
            if t >= next_switch:
                t = self.switch(t)
                next_switch = t + rng.exponential(60 / p["switch_per_min"])
            elif t >= next_window:
                t = self.window(t)
                next_window = t + rng.exponential(60 / p["window_per_min"])
            act = int(rng.choice(4, p=mix / mix.sum()))
            if act == 0:
                t = self.typing(t, ctx, drift)
            elif act == 1:
                for _ in range(int(rng.integers(1, 6))):
                    t = self.mouse(t) + self.ln(math.log(250), 0.5) / 1000
            elif act == 2:
                for _ in range(int(rng.integers(1, 5))):
                    t = self.scroll(t) + self.ln(p["sc_gap_mu"], 0.6) / 1000
            else:
                t += self.ln(p["idle_mu"], 0.6) / 1000 if rng.random() < 0.5 + p["idle_p"] else 1.0
            t += self.ln(p["gap_mu"], 0.5) / 1000
        return t


def session(rng, person, trans, start_s, minutes, actor, label):
    w = Writer(rng, person, trans)
    t, end = start_s, start_s + minutes * 60
    drift = rng.normal(0, 0.06)  # session-level habit drift, same person
    while t < end:
        ctx = CONTEXTS[str(rng.choice(list(CONTEXTS)))]
        t = w.phase(t, min(end, t + rng.uniform(60, 240)), ctx, drift)
    header = {"ev": "header", "schema_version": 1, "synthetic": True, "display": DISPLAY,
              "pointer": "trackpad", "label": label, "actor": actor}
    return [header] + sorted(w.ev, key=lambda e: e["t_ns"]), t


def simulate_pair(seed, similarity=0.6, a_minutes=(15, 14, 13), b_minutes=15):
    """Return (A session logs, B session logs) for one seeded pair of people."""
    rng = np.random.default_rng(seed)
    base_a, base_b = draw_person(rng), draw_person(rng)
    a = finalize(base_a)
    b = finalize(shrink(base_a, base_b, similarity))
    ta = transition_habits(rng)
    tb = transition_habits(rng, ta, similarity)
    a_logs, t = [], 0.0
    for minutes in a_minutes:
        log, t = session(rng, a, ta, t, minutes, "a", "genuine")
        a_logs.append(log)
        t += 3 * 3600  # hours between owner sessions
    b_log, _ = session(rng, b, tb, 0.0, b_minutes, "b", "impostor")
    return a_logs, [b_log]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--similarity", type=float, default=0.6)
    ap.add_argument("--output", required=True, help="directory for synthetic *.jsonl logs")
    args = ap.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    a_logs, b_logs = simulate_pair(args.seed, args.similarity)
    for name, logs in (("a", a_logs), ("b", b_logs)):
        for i, log in enumerate(logs, 1):
            (out / f"sim_{name}{i}.jsonl").write_text("".join(json.dumps(e) + "\n" for e in log))
    print(f"Wrote synthetic logs to {out}")


if __name__ == "__main__":
    main()
