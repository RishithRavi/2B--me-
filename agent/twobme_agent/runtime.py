from collections import Counter, deque
import subprocess
from urllib.parse import urlsplit
from twobme_features import Accumulators
from twobme_features.accumulators import add_event, MODIFIERS
from .privacy import safe_tick
from .transport import iso


class TickBuilder:
    def __init__(self, spec, display, run_id, pointer="trackpad"):
        self.spec = spec
        self.acc = Accumulators(spec, display)
        self.run_id = run_id
        self.pointer = pointer
        self.seq = 0
        self.counts = Counter()
        self.activity = deque()
        self.last_input = None
        self.secure = False
        self.injected = 0

    def add(self, e):
        kind = e["ev"]
        t = e["t_ns"]
        active = False
        if kind == "secure_input":
            self.secure = e["on"]
            if self.secure:
                self.acc.keys.clear()
                self.acc.pending.clear()
                self.acc.slots.clear()
                self.acc.shift = None
        if kind == "key" and self.secure:
            return
        if (
            kind == "key"
            and e["down"]
            and not e.get("autorepeat")
            and e["cls"] not in MODIFIERS
        ):
            self.counts["keys"] += 1
            active = True
        elif kind == "mouse":
            field = (
                "clicks"
                if e["kind"] == "down"
                else "mouse_moves"
                if e["kind"] in ("move", "drag")
                else None
            )
            if field:
                self.counts[field] += 1
                active = True
        elif kind == "scroll" and not e.get("momentum"):
            self.counts["scroll_events"] += 1
            active = True
        elif kind == "app":
            self.counts["app_switches"] += 1
        if active:
            self.activity.append(t)
            self.last_input = t
        self.injected += bool(e.get("inj"))
        add_event(self.acc, e)

    def tick(self, now_ns, session_id, clock):
        blocks = self.acc.poll(now_ns)
        context = self.acc.context(now_ns)

        def wire(b):
            d = b.model_dump(mode="json")
            for field in ("t_start", "t_end"):
                t = getattr(b, field).timestamp() * 1e9
                d[field] = iso(clock.wall(int(t)))
            return d

        while self.activity and self.activity[0] < now_ns - 5_000_000_000:
            self.activity.popleft()
        activity = [0] * 5
        for t in self.activity:
            activity[
                min(4, max(0, int((t - (now_ns - 5_000_000_000)) // 1_000_000_000)))
            ] += 1
        tick = {
            "type": "tick",
            "run_id": self.run_id,
            "session_id": session_id,
            "seq": self.seq,
            "t_end": iso(clock.wall(now_ns)),
            "flags": {
                "secure_input": self.secure,
                "injected": self.injected,
                "pointer": self.pointer,
                "late": False,
                "idle_s": (now_ns - self.last_input) / 1e9 if self.last_input else 0.0,
                "clock_skew": False,
            },
            "counts": {
                k: self.counts[k]
                for k in [
                    "keys",
                    "mouse_moves",
                    "clicks",
                    "scroll_events",
                    "app_switches",
                ]
            },
            "activity": activity,
            "blocks": [wire(b) for b in blocks],
            "context": wire(context) if context else None,
        }
        self.seq += 1
        self.counts.clear()
        self.injected = 0
        return safe_tick(tick, self.spec)


def notify(message):
    # Fixed messages only; no server-supplied string is interpolated into AppleScript.
    scripts = {
        "challenge": 'display notification "Please verify your identity in 2bME." with title "2bME"',
        "lock": 'display notification "Device session locked. Verify to recover." with title "2bME"',
        "unlock": 'display notification "Identity verified. Session unlocked." with title "2bME"',
    }
    if message in scripts:
        subprocess.run(["osascript", "-e", scripts[message]], capture_output=True)


def handle_message(message, base):
    kind = message.get("type")
    if kind in ("challenge", "lock", "unlock"):
        notify(kind)
    if kind == "challenge" and message.get("browser_live_recent") is False:
        url = message.get("verify_url", "")
        target = urlsplit(url)
        origin = urlsplit(base)
        if (
            target.scheme == origin.scheme
            and target.netloc == origin.netloc
            and target.path == "/verify"
        ):
            subprocess.run(["open", url], check=False)
