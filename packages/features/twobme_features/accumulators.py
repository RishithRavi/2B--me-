from __future__ import annotations
from collections import Counter, deque
from datetime import datetime, timezone
import math
import numpy as np
from scipy.signal import welch, find_peaks
from twobme_common.types import Block

MODIFIERS = {"SHIFT", "CMD", "CTRL", "OPT", "CAPS"}
CATEGORIES = {"browser", "ide", "terminal", "chat", "docs", "media", "system", "other"}
NS = 1_000_000_000


def names(spec, modality):
    if hasattr(spec, "names"):
        return list(spec.names(modality))
    return [
        f["name"] if isinstance(f, dict) else f
        for f in spec["modalities"][modality]["features"]
    ]


def percentile(xs, p=50):
    a = np.asarray([x for x in xs if x is not None and np.isfinite(x)], dtype=float)
    return float(np.percentile(a, p)) if len(a) else None


def iqr(xs):
    a, b = percentile(xs, 75), percentile(xs, 25)
    return a - b if a is not None else None


def mean(xs):
    return float(np.mean(xs)) if len(xs) else None


def entropy(xs):
    a = np.asarray(xs, dtype=float)
    if a.sum() <= 0:
        return 0.0
    p = a[a > 0] / a.sum()
    return float(-np.sum(p * np.log2(p)))


def stamp(t):
    return datetime.fromtimestamp(t / NS, timezone.utc)


class Accumulators:
    def __init__(self, spec, display):
        self.spec = spec
        w = display.w_pt if hasattr(display, "w_pt") else display["w_pt"]
        h = display.h_pt if hasattr(display, "h_pt") else display["h_pt"]
        self.diagonal = math.hypot(w, h)
        if self.diagonal <= 0:
            raise ValueError("Display diagonal must be positive")
        self.keys, self.pending, self.out = [], [], []
        self.slots, self.shift, self.chords = {}, None, []
        self.stroke, self.actions, self.scroll, self.bursts = [], [], [], []
        self.button_down, self.last_click, self.last_burst = {}, None, None
        self.momentum = self.scroll_total = 0
        self.wf = []
        self.category = None
        self.focus_at = self.focus_input = None
        self.last_input = None
        self.temporal = deque()
        self.last_t = 0

    def _activity(self, t):
        self.temporal.append(t)
        while self.temporal and self.temporal[0] < t - 60 * NS:
            self.temporal.popleft()

    def _input(self, t, modality):
        if self.focus_at is not None and self.focus_input is None:
            self.wf.append((t, "latency", (t - self.focus_at) / 1e6))
            self.focus_input = t
        if self.last_input and self.last_input[1] != modality:
            self.wf.append(
                (
                    t,
                    "k2m" if self.last_input[1] == "k" else "m2k",
                    (t - self.last_input[0]) / 1e6,
                )
            )
        self.last_input = (t, modality)

    def _block(self, m, start, end, n, values, **extra):
        features = {name: values.get(name) for name in names(self.spec, m)}
        features = {
            k: (float(v) if v is not None and np.isfinite(v) else None)
            for k, v in features.items()
        }
        return Block(
            modality=m,
            t_start=stamp(start),
            t_end=stamp(end),
            n=n,
            features=features,
            **extra,
        )

    def _advance(self, t):
        if t < self.last_t:
            raise ValueError("Events must be monotonic")
        self.last_t = t
        self.chords = [x for x in self.chords if x[0] >= t - 60 * NS]
        if self.stroke and self.stroke[0][0] < t - 60 * NS:
            self.stroke = [p for p in self.stroke if p[0] >= t - 60 * NS]
        if self.keys and t - self.keys[0]["t"] >= 15 * NS:
            self._close_keys(self.keys[0]["t"] + 15 * NS, len(self.keys) >= 8)
        for k, deadline, end, chords in list(self.pending):
            if t >= deadline or all(x["up"] is not None for x in k):
                self.out.append(self._keyboard(k, end, chords))
                self.pending.remove((k, deadline, end, chords))
                for x in k:
                    if self.slots.get(x["slot"]) is x:
                        self.slots.pop(x["slot"], None)
        if self.stroke and t - self.stroke[-1][0] >= 0.3 * NS:
            self._close_stroke()
        if self.scroll and t - self.scroll[-1][0] >= 0.3 * NS:
            self._close_scroll()
        if self.actions and t - self.actions[0]["start"] >= 15 * NS:
            self._close_mouse(len(self.actions) >= 2)
        if self.bursts and t - self.bursts[0]["start"] >= 30 * NS:
            self._emit_scroll()
        if self.wf and t - self.wf[0][0] >= 60 * NS:
            self._workflow(self.wf[0][0] + 60 * NS)

    def add_key(self, t_ns, down, slot, cls, autorepeat=False):
        self._advance(t_ns)
        if autorepeat:
            return
        if cls in MODIFIERS:
            if cls == "SHIFT":
                self.shift = t_ns if down else None
            return
        if down:
            self._activity(t_ns)
            self._input(t_ns, "k")
            item = {
                "t": t_ns,
                "up": None,
                "slot": slot,
                "cls": cls,
                "shift": (t_ns - self.shift) / 1e6 if self.shift is not None else None,
            }
            self.slots[slot] = item
            self.keys.append(item)
            if len(self.keys) >= 20:
                self._close_keys(t_ns, True)
        elif slot in self.slots:
            self.slots[slot]["up"] = t_ns
            self._advance(t_ns)

    def add_chord(self, t_ns, kind):
        self._advance(t_ns)
        self.chords.append((t_ns, kind))
        self.wf.append((t_ns, "chord", kind))

    def _close_keys(self, end, emit):
        k, self.keys = self.keys, []
        chords = [x for x in self.chords if k[0]["t"] <= x[0] <= end]
        self.chords = [x for x in self.chords if x[0] > end]
        if emit:
            self.pending.append((k, end + int(1.5 * NS), end, chords))
        else:
            for x in k:
                self.slots.pop(x["slot"], None)

    def _keyboard(self, k, end, chords):
        v = {}
        put = lambda n, x: v.update({"kb." + n: x})
        holds = [(x["up"] - x["t"]) / 1e6 if x["up"] is not None else None for x in k]
        put("hold_p50", percentile(holds))
        put("hold_iqr", iqr(holds))
        for suffix, c in [("L", "L_LETTER"), ("R", "R_LETTER"), ("space", "SPACE")]:
            put(
                "hold_p50_" + suffix,
                percentile([h for h, x in zip(holds, k) if x["cls"] == c]),
            )
        pairs = [(a, b, (b["t"] - a["t"]) / 1e6) for a, b in zip(k, k[1:])]
        dd = [d for a, b, d in pairs if d <= 1500]
        ud = [
            (b["t"] - a["up"]) / 1e6
            for a, b, d in pairs
            if a["up"] is not None and d <= 1500
        ]
        put("dd_p50", percentile(dd))
        put("dd_iqr", iqr(dd))
        put("ud_p50", percentile(ud))
        put("ud_iqr", iqr(ud))
        put("rollover_frac", mean([x < 0 for x in ud]))
        for label, pred in [
            ("same_hand", lambda a, b: a == b and a.endswith("LETTER")),
            (
                "cross_hand",
                lambda a, b: a != b and a.endswith("LETTER") and b.endswith("LETTER"),
            ),
            ("letter_space", lambda a, b: a.endswith("LETTER") and b == "SPACE"),
            ("space_letter", lambda a, b: a == "SPACE" and b.endswith("LETTER")),
        ]:
            put(
                "dd_p50_" + label,
                percentile(
                    [d for a, b, d in pairs if d <= 1500 and pred(a["cls"], b["cls"])]
                ),
            )
        tri = [
            (c["t"] - a["t"]) / 1e6
            for a, b, c in zip(k, k[1:], k[2:])
            if all(x["cls"].endswith("LETTER") for x in (a, b, c))
            and max(b["t"] - a["t"], c["t"] - b["t"]) <= 1.5 * NS
        ]
        put("tri_p50", percentile(tri))
        put("tri_iqr", iqr(tri))
        short = [d for a, b, d in pairs if 0 < d < 500]
        put("speed_kps", 1000 / mean(short) if short else None)
        runs = [1]
        for a, b, d in pairs:
            if d >= 500:
                runs.append(1)
            else:
                runs[-1] += 1
        put("burst_len_mean", mean(runs))
        put("pause_rate", sum(d > 1000 for a, b, d in pairs) / len(k))
        bk = []
        run = 0
        for x in k:
            if x["cls"] == "BKSP":
                run += 1
            elif run:
                bk.append(run)
                run = 0
        if run:
            bk.append(run)
        put("bksp_rate", sum(x["cls"] == "BKSP" for x in k) / len(k))
        put("bksp_run_mean", mean(bk))
        put(
            "pre_bksp_dd_p50",
            percentile(
                [d for a, b, d in pairs if b["cls"] == "BKSP" and a["cls"] != "BKSP"]
            ),
        )
        put(
            "post_bksp_dd_p50",
            percentile(
                [d for a, b, d in pairs if a["cls"] == "BKSP" and b["cls"] != "BKSP"]
            ),
        )
        put("shift_lead_p50", percentile([x["shift"] for x in k]))
        put("chord_rate", len(chords) / len(k))
        return self._block("keyboard", k[0]["t"], end, len(k), v)

    def add_mouse(self, t_ns, x_pt, y_pt, kind, button=0):
        self._advance(t_ns)
        self._activity(t_ns)
        self._input(t_ns, "m")
        p = (t_ns, x_pt / self.diagonal, y_pt / self.diagonal, kind)
        if kind == "down":
            pause = (t_ns - self.stroke[-1][0]) / 1e6 if self.stroke else None
            action = self._close_stroke("PC", t_ns)
            self.button_down[button] = (t_ns, action)
            if action is not None:
                action["pre_click_pause"] = pause
                action["dblclick"] = (
                    (t_ns - self.last_click) / 1e6
                    if self.last_click and t_ns - self.last_click <= 0.5 * NS
                    else None
                )
            self.last_click = t_ns
        elif kind == "up":
            action = self._close_stroke("DD", t_ns)
            if button in self.button_down:
                start, clicked = self.button_down.pop(button)
                for a in (clicked, action):
                    if a is not None:
                        a["click_hold"] = (t_ns - start) / 1e6
        else:
            self.stroke.append(p)
        if len(self.actions) >= 5 and not self.button_down:
            self._close_mouse(True)

    def _close_stroke(self, kind=None, end=None):
        raw, self.stroke = self.stroke, []
        if len(raw) < 4:
            return None
        t = np.array([p[0] for p in raw], dtype=float) / NS
        t = t - t[0]
        if t[-1] <= 0:
            return None
        xy = np.array([[p[1], p[2]] for p in raw])
        grid = np.arange(0, t[-1] + 1e-9, 1 / 60)
        if len(grid) < 4:
            return None
        pos = np.column_stack([np.interp(grid, t, xy[:, i]) for i in range(2)])
        vel = np.gradient(pos, 1 / 60, axis=0)
        acc = np.gradient(vel, 1 / 60, axis=0)
        speed = np.linalg.norm(vel, axis=1)
        acceleration = np.linalg.norm(acc, axis=1)
        jerk = np.linalg.norm(np.gradient(acc, 1 / 60, axis=0), axis=1)
        curvature = np.abs(vel[:, 0] * acc[:, 1] - vel[:, 1] * acc[:, 0]) / np.maximum(
            speed**3, 1e-10
        )
        angles = np.unwrap(np.arctan2(vel[:, 1], vel[:, 0]))
        path = np.linalg.norm(np.diff(pos, axis=0), axis=1).sum()
        dwell = []
        d = 0.0
        for dt, dist in zip(np.diff(t), np.linalg.norm(np.diff(xy, axis=0), axis=1)):
            if dist / max(dt, 1e-9) < 0.01:
                d += dt
            else:
                if d > 0.1:
                    dwell.append(d * 1000)
                d = 0.0
        if d > 0.1:
            dwell.append(d * 1000)
        # Silence before the stroke timeout is also a geometric dwell.
        tail = (
            (end if end is not None else raw[-1][0] + int(0.3 * NS)) - raw[-1][0]
        ) / NS
        if tail > 0.1:
            dwell.append(tail * 1000)
        a = {
            "start": raw[0][0],
            "end": end or raw[-1][0],
            "kind": kind or ("DD" if any(p[3] == "drag" for p in raw) else "MM"),
            "v_p50": percentile(speed),
            "v_p90": percentile(speed, 90),
            "a_p50": percentile(acceleration),
            "jerk_p50": percentile(jerk),
            "curv_p50": percentile(curvature),
            "angvel_p50": percentile(np.abs(np.gradient(angles, 1 / 60))),
            "straightness": float(np.linalg.norm(pos[-1] - pos[0]) / path)
            if path
            else 1.0,
            "path": float(path),
            "dur": float(t[-1] * 1000),
            "t_peak_frac": float(np.argmax(speed) / max(1, len(speed) - 1)),
            "submoves": float(
                len(find_peaks(speed, prominence=max(0.001, speed.max() * 0.1))[0])
            ),
            "direction": int(
                ((math.atan2(*(xy[-1] - xy[0])[::-1]) + math.pi) / (2 * math.pi) * 8)
            )
            % 8,
            "dwell_rate": len(dwell) / t[-1],
            "dwell": percentile(dwell),
        }
        self.actions.append(a)
        if len(self.actions) >= 5 and kind is None:
            self._close_mouse(True)
        return a

    def _close_mouse(self, emit):
        aa, self.actions = self.actions, []
        if not emit or not aa:
            return
        v = {}
        for name in [
            "v_p50",
            "v_p90",
            "a_p50",
            "jerk_p50",
            "curv_p50",
            "angvel_p50",
            "dwell_rate",
        ]:
            v["ms." + name] = percentile([a.get(name) for a in aa])
        for name in [
            "straightness",
            "path",
            "dur",
            "t_peak_frac",
            "submoves",
            "click_hold",
            "pre_click_pause",
            "dblclick",
            "dwell",
        ]:
            v["ms." + name + "_p50"] = percentile([a.get(name) for a in aa])
        v.update(
            {
                "ms.frac_pc": mean([a["kind"] == "PC" for a in aa]),
                "ms.frac_dd": mean([a["kind"] == "DD" for a in aa]),
                "ms.dir_entropy": entropy(
                    list(Counter(a["direction"] for a in aa).values())
                ),
            }
        )
        self.out.append(self._block("mouse", aa[0]["start"], aa[-1]["end"], len(aa), v))

    def add_scroll(self, t_ns, dy, dx, continuous=True, phase=0, momentum=0):
        self._advance(t_ns)
        self.scroll_total += 1
        if momentum:
            self.momentum += 1
            return
        self._activity(t_ns)
        self._input(t_ns, "m")
        self.scroll.append((t_ns, dy / self.diagonal, dx / self.diagonal))

    def _close_scroll(self):
        ss, self.scroll = self.scroll, []
        if not ss:
            return
        t = np.array([s[0] for s in ss], dtype=float) / NS
        dt = np.diff(t)
        dy = np.array([s[1] for s in ss])
        dx = np.array([s[2] for s in ss])
        dist = np.hypot(dy, dx)
        vs = dist[1:] / np.maximum(dt, 1e-9)
        nonzero = dy[dy != 0]
        self.bursts.append(
            {
                "start": ss[0][0],
                "end": ss[-1][0],
                "burst_dur": (t[-1] - t[0]) * 1000,
                "burst_events": len(ss),
                "burst_dist": float(dist.sum()),
                "v_peak": float(vs.max()) if len(vs) else None,
                "v_mean": float(vs.mean()) if len(vs) else None,
                "iei_cv": float(dt.std() / dt.mean())
                if len(dt) and dt.mean() > 0
                else None,
                "inter_burst": (ss[0][0] - self.last_burst) / 1e6
                if self.last_burst is not None
                else None,
                "reversals": sum(nonzero[1:] * nonzero[:-1] < 0),
                "n": len(ss),
                "horizontal": float(np.abs(dx).sum()),
                "distance": float(np.abs(dx).sum() + np.abs(dy).sum()),
            }
        )
        self.last_burst = ss[-1][0]
        if len(self.bursts) >= 3:
            self._emit_scroll()

    def _emit_scroll(self):
        bb, self.bursts = self.bursts, []
        if not bb:
            return
        v = {
            "sc." + n + "_p50": percentile([b[n] for b in bb])
            for n in [
                "burst_dur",
                "burst_events",
                "burst_dist",
                "v_peak",
                "v_mean",
                "iei_cv",
                "inter_burst",
            ]
        }
        v.update(
            {
                "sc.reversal_rate": sum(b["reversals"] for b in bb)
                / sum(b["n"] for b in bb),
                "sc.momentum_frac": self.momentum / max(1, self.scroll_total),
                "sc.horizontal_frac": sum(b["horizontal"] for b in bb)
                / max(1e-12, sum(b["distance"] for b in bb)),
            }
        )
        self.momentum = self.scroll_total = 0
        self.out.append(
            self._block("scroll", bb[0]["start"], bb[-1]["end"], len(bb), v)
        )

    def add_app(self, t_ns, cat, via="other"):
        self._advance(t_ns)
        if cat not in CATEGORIES:
            raise ValueError("Unknown application category")
        if self.focus_at is not None:
            self.wf.append((t_ns, "dwell", (t_ns - self.focus_at) / 1e6))
        self.wf.append((t_ns, "app", (self.category, cat, via)))
        self.category = cat
        self.focus_at = t_ns
        self.focus_input = None

    def add_window_change(self, t_ns):
        self._advance(t_ns)
        self.wf.append((t_ns, "window", 1))

    def _workflow(self, end):
        ww = [x for x in self.wf if x[0] <= end]
        self.wf = [x for x in self.wf if x[0] > end]
        apps = [x[2] for x in ww if x[1] == "app"]
        windows = sum(x[1] == "window" for x in ww)
        if not apps and not windows:
            return
        duration = max(1, (end - ww[0][0]) / NS)
        v = {
            "wf.switch_rate": len(apps) / duration,
            "wf.win_change_rate": windows / duration,
            "wf.kbd_switch_frac": mean([a[2] == "cmdtab" for a in apps]),
            "wf.tab_chord_rate": sum(
                x[1] == "chord" and x[2].startswith("tab_") for x in ww
            )
            / duration,
        }
        for feat, kind in [
            ("switch_latency", "latency"),
            ("k2m", "k2m"),
            ("m2k", "m2k"),
            ("app_dwell", "dwell"),
        ]:
            v["wf." + feat + "_p50"] = percentile([x[2] for x in ww if x[1] == kind])
        tr = dict(Counter(a + ">" + b for a, b, via in apps if a is not None))
        self.out.append(
            self._block(
                "workflow", ww[0][0], end, len(apps) + windows, v, transitions=tr
            )
        )

    def poll(self, now_ns):
        self._advance(now_ns)
        out, self.out = self.out, []
        return out

    def context(self, now_ns):
        while self.temporal and self.temporal[0] < now_ns - 60 * NS:
            self.temporal.popleft()
        tt = (
            np.asarray(
                [t for t in self.temporal if now_ns - 30 * NS <= t <= now_ns],
                dtype=float,
            )
            / NS
        )
        if len(tt) < 30:
            return None
        gaps = np.diff(tt)
        mu = float(gaps.mean())
        sd = float(gaps.std())
        n = len(gaps)
        r = sd / mu if mu else 0
        idle = gaps[gaps > 2]
        counts, _ = np.histogram(
            tt, bins=np.linspace(now_ns / NS - 30, now_ns / NS, 1501)
        )
        f, p = welch(counts, fs=50, nperseg=256)
        centered = counts - counts.mean()
        acf = np.correlate(centered, centered, mode="full")[1499:]
        acf = acf / acf[0] if acf[0] else np.zeros_like(acf)
        peaks = find_peaks(acf[1:751])[0] + 1
        lag = int(peaks[np.argmax(acf[peaks])]) if len(peaks) else 1
        v = {
            "tp.rate": len(tt) / 30,
            "tp.B": (sd - mu) / (sd + mu) if sd + mu else 0,
            "tp.Bn": (math.sqrt(n + 1) * r - math.sqrt(n - 1))
            / ((math.sqrt(n + 1) - 2) * r + math.sqrt(n - 1))
            if n > 1
            else None,
            "tp.M": float(np.corrcoef(gaps[:-1], gaps[1:])[0, 1])
            if len(gaps) > 2 and np.std(gaps[:-1]) > 0 and np.std(gaps[1:]) > 0
            else None,
            "tp.idle_frac": float(idle.sum() / 30),
            "tp.idle_p50": percentile(idle * 1000),
            "tp.idle_p90": percentile(idle * 1000, 90),
            "tp.spec_entropy": entropy(p),
            "tp.peak_hz": float(f[np.argmax(p)]),
            "tp.centroid_hz": float(np.dot(f, p) / p.sum()) if p.sum() else 0,
            "tp.acf_peak_lag": lag * 20.0,
            "tp.acf_peak": float(acf[lag]),
        }
        for name, lo, hi in [
            ("0_05", 0, 0.5),
            ("05_2", 0.5, 2),
            ("2_5", 2, 5),
            ("5_10", 5, 10),
            ("10_25", 10, 25),
        ]:
            v["tp.bp_" + name] = float(
                p[(f >= lo) & (f < (hi if hi < 25 else 26))].sum() * (f[1] - f[0])
            )
        psd = np.interp(
            np.linspace(0, 25, 32), f, 10 * np.log10(np.maximum(p, 1e-12))
        ).tolist()
        return self._block("temporal", now_ns - 30 * NS, now_ns, len(tt), v, psd=psd)


def add_event(acc, event):
    e = event
    t = e.get("t_ns", 0)
    kind = e["ev"]
    if kind == "key":
        acc.add_key(t, e["down"], e["slot"], e["cls"], e.get("autorepeat", False))
    elif kind == "chord":
        acc.add_chord(t, e["kind"])
    elif kind == "mouse":
        acc.add_mouse(t, e["x_pt"], e["y_pt"], e["kind"], e.get("button", 0))
    elif kind == "scroll":
        acc.add_scroll(
            t,
            e["dy"],
            e["dx"],
            e.get("continuous", True),
            e.get("phase", 0),
            e.get("momentum", 0),
        )
    elif kind == "app":
        acc.add_app(t, e["cat"], e.get("via", "other"))
    elif kind == "window":
        acc.add_window_change(t)


def features_from_events(events, spec):
    it = iter(events)
    header = next(it)
    if header.get("ev") != "header":
        raise ValueError("Event log must begin with a header")
    acc = Accumulators(spec, header["display"])
    tick = None
    last = 0
    for e in it:
        t = e["t_ns"]
        last = t
        if tick is None:
            tick = (t // (5 * NS) + 1) * 5 * NS
        while tick <= t:
            yield tick, acc.poll(tick), acc.context(tick)
            tick += 5 * NS
        add_event(acc, e)
    if tick is not None:
        while tick <= last + 31 * NS:
            yield tick, acc.poll(tick), acc.context(tick)
            tick += 5 * NS
