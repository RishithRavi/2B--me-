"""macOS capture. Native identities are reduced on the capture/main thread."""

from collections import deque
from pathlib import Path
import ctypes
import json
import time


def secure_input():
    carbon = ctypes.CDLL("/System/Library/Frameworks/Carbon.framework/Carbon")
    carbon.IsSecureEventInputEnabled.restype = ctypes.c_bool
    return bool(carbon.IsSecureEventInputEnabled())


def preflight():
    cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
    cg.CGPreflightListenEventAccess.restype = ctypes.c_bool
    return bool(cg.CGPreflightListenEventAccess())


class EventClock:
    """Select ns vs Mach timebase by observed elapsed event time, avoiding uptime guesses."""

    def __init__(self):
        class Timebase(ctypes.Structure):
            _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]

        tb = Timebase()
        ctypes.CDLL("/usr/lib/libSystem.B.dylib").mach_timebase_info(ctypes.byref(tb))
        self.timebase = tb.numer / tb.denom
        self.factor = 1.0
        self.first = None
        self.offset = None
        self.last = 0

    def convert(self, raw):
        now = time.monotonic_ns()
        if self.first is None:
            self.first = (raw, now)
        dr = raw - self.first[0]
        dn = now - self.first[1]
        if dr > 0 and dn > 500_000_000:
            self.factor = min([1.0, self.timebase], key=lambda f: abs(dr * f - dn))
        converted = int(raw * self.factor)
        # Re-estimate origin after calibration; callback latency is not used for intervals after that.
        if self.offset is None or abs(converted + self.offset - now) > NS:
            self.offset = now - converted
        t = max(self.last, converted + self.offset)
        self.last = t
        return t


NS = 1_000_000_000


class Capture:
    def __init__(self, contracts="contracts", pointer="trackpad"):
        self.classes = json.loads((Path(contracts) / "key_classes.json").read_text())[
            "macos"
        ]
        self.categories = json.loads(
            (Path(contracts) / "app_categories.json").read_text()
        )["bundles"]
        self.queue = deque(maxlen=100000)
        self.clock = EventClock()
        self.pointer = pointer
        self.slots = {}
        self.held_at = {}
        self.mods = set()
        self.next_slot = 0
        self.excluded = set()
        self.last_event_ns = 0
        self.n_events = 0
        self.n_moves = 0
        self.dropped = 0
        self.tap = None
        self.secure = False
        self.last_window = None
        self.last_cat = None
        self.cmdtab_at = 0
        self.takeover = False
        self.last_locked = None
        self.last_watchdog = 0
        self.running = True
        self.observers = []
        self.last_emitted = 0

    def emit(self, e):
        e["t_ns"] = max(e["t_ns"], self.last_emitted)
        self.last_emitted = e["t_ns"]
        if len(self.queue) == self.queue.maxlen:
            self.dropped += 1
        self.queue.append(e)

    def _chord(self, k, flags):
        Q = self.Q
        cmd = bool(flags & Q.kCGEventFlagMaskCommand)
        ctrl = bool(flags & Q.kCGEventFlagMaskControl)
        shift = bool(flags & Q.kCGEventFlagMaskShift)
        opt = bool(flags & Q.kCGEventFlagMaskAlternate)
        if cmd and ctrl and opt and k in (46, 15):
            return "marker" if k == 46 else "reset"
        if (ctrl and k == 48) or (cmd and shift and k in (30, 33)):
            return "tab_cycle"
        if not cmd:
            return None
        if k == 17:
            return "tab_new"
        if k == 13:
            return "tab_close"
        if k in (18, 19, 20, 21, 22, 23, 25, 26, 28):
            return "tab_jump"
        if k == 48:
            return "app_switch_kbd"
        if k == 50:
            return "window_cycle"
        return "other_cmd"

    def callback(self, proxy, kind, event, refcon):
        Q = self.Q
        if kind in (Q.kCGEventTapDisabledByTimeout, Q.kCGEventTapDisabledByUserInput):
            Q.CGEventTapEnable(self.tap, True)
            return event
        t = self.clock.convert(Q.CGEventGetTimestamp(event))
        self.last_event_ns = time.monotonic_ns()
        self.n_events += 1
        inj = bool(Q.CGEventGetIntegerValueField(event, Q.kCGEventSourceUnixProcessID))
        if kind in (Q.kCGEventKeyDown, Q.kCGEventKeyUp, Q.kCGEventFlagsChanged):
            if self.secure:
                return event
            k = Q.CGEventGetIntegerValueField(event, Q.kCGKeyboardEventKeycode)
            flags = Q.CGEventGetFlags(event)
            cls = self.classes.get(str(k), "OTHER")
            repeat = bool(
                Q.CGEventGetIntegerValueField(event, Q.kCGKeyboardEventAutorepeat)
            )
            down = kind == Q.kCGEventKeyDown
            if kind == Q.kCGEventFlagsChanged:
                if not flags & 0xFFFF0000:
                    for mk in list(self.mods):
                        self.emit(
                            {
                                "t_ns": t,
                                "ev": "key",
                                "down": False,
                                "slot": self.slots.pop(mk, 0),
                                "cls": self.classes.get(str(mk), "OTHER"),
                                "autorepeat": False,
                                "inj": inj,
                            }
                        )
                    self.mods.clear()
                    return event
                down = k not in self.mods
                if down:
                    self.mods.add(k)
                else:
                    self.mods.discard(k)
                if cls == "CAPS":
                    down = True
            chord = self._chord(k, flags) if down and not repeat else None
            # ⌥⌫ (delete word) is a correction-style habit. The runtime turns it into a per-tick count; the key
            # itself still flows as an ordinary BKSP class event below, so feature statistics don't change.
            word_delete = (
                kind == Q.kCGEventKeyDown
                and not repeat
                and cls == "BKSP"
                and bool(flags & Q.kCGEventFlagMaskAlternate)
                and not flags & (Q.kCGEventFlagMaskCommand | Q.kCGEventFlagMaskControl)
            )
            if chord in ("marker", "reset"):
                self.excluded.add(k)
                if chord == "marker":
                    self.takeover = not self.takeover
                    self.emit(
                        {
                            "t_ns": t,
                            "ev": "control",
                            "action": "takeover_start"
                            if self.takeover
                            else "takeover_end",
                        }
                    )
                    self.emit(
                        {
                            "t_ns": t,
                            "ev": "label",
                            "label": "impostor" if self.takeover else "genuine",
                            "actor": "b" if self.takeover else "a",
                        }
                    )
                else:
                    self.emit({"t_ns": t, "ev": "control", "action": "reset"})
                return event
            if k in self.excluded:
                if not down:
                    self.excluded.remove(k)
                return event
            if down and not repeat:
                self.next_slot += 1
                self.slots[k] = self.next_slot
                self.held_at[k] = t
            slot = self.slots.get(k)
            if slot is not None:
                self.emit(
                    {
                        "t_ns": t,
                        "ev": "key",
                        "down": down,
                        "slot": slot,
                        "cls": cls,
                        "autorepeat": repeat,
                        "inj": inj,
                    }
                )
            if not down:
                self.slots.pop(k, None)
                self.held_at.pop(k, None)
            if word_delete:
                self.emit({"t_ns": t, "ev": "habit", "kind": "word_delete"})
            if chord:
                if chord == "app_switch_kbd":
                    self.cmdtab_at = t
                self.emit({"t_ns": t, "ev": "chord", "kind": chord})
            return event
        if kind == Q.kCGEventScrollWheel:
            get = lambda f: Q.CGEventGetIntegerValueField(event, f)
            self.emit(
                {
                    "t_ns": t,
                    "ev": "scroll",
                    "dy": get(96),
                    "dx": get(97),
                    "continuous": bool(get(88)),
                    "phase": get(99),
                    "momentum": get(123),
                }
            )
        else:
            p = Q.CGEventGetLocation(event)
            mouse_kind = (
                "down"
                if kind
                in (
                    Q.kCGEventLeftMouseDown,
                    Q.kCGEventRightMouseDown,
                    Q.kCGEventOtherMouseDown,
                )
                else "up"
                if kind
                in (
                    Q.kCGEventLeftMouseUp,
                    Q.kCGEventRightMouseUp,
                    Q.kCGEventOtherMouseUp,
                )
                else "drag"
                if kind
                in (
                    Q.kCGEventLeftMouseDragged,
                    Q.kCGEventRightMouseDragged,
                    Q.kCGEventOtherMouseDragged,
                )
                else "move"
            )
            self.n_moves += mouse_kind in ("move", "drag")
            self.emit(
                {
                    "t_ns": t,
                    "ev": "mouse",
                    "kind": mouse_kind,
                    "x_pt": p.x,
                    "y_pt": p.y,
                    "button": int(
                        Q.CGEventGetIntegerValueField(
                            event, Q.kCGMouseEventButtonNumber
                        )
                    ),
                    "inj": inj,
                }
            )
        return event

    def app_changed(self, notification=None):
        from AppKit import NSWorkspace

        app = NSWorkspace.sharedWorkspace().frontmostApplication()
        # This is the only native bundle lookup. Only the category enters the queue.
        cat = self.categories.get(app.bundleIdentifier(), "other") if app else "other"  # privacy-ok: category-map
        now = time.monotonic_ns()
        self.emit(
            {
                "t_ns": now,
                "ev": "app",
                "cat": cat,
                "via": "cmdtab" if now - self.cmdtab_at < 2 * NS else "other",
            }
        )
        self.last_cat = cat

    def poll_system(self, timer=None):
        Q = self.Q
        now = time.monotonic_ns()
        for k, pressed in list(self.held_at.items()):
            if now - pressed > 60 * NS:
                self.slots.pop(k, None)
                self.mods.discard(k)
                self.held_at.pop(k, None)
        secure = secure_input()
        if secure != self.secure:
            self.secure = secure
            self.slots.clear()
            self.mods.clear()
            self.emit({"t_ns": now, "ev": "secure_input", "on": secure})
        windows = (
            Q.CGWindowListCopyWindowInfo(
                Q.kCGWindowListOptionOnScreenOnly
                | Q.kCGWindowListExcludeDesktopElements,
                Q.kCGNullWindowID,
            )
            or []
        )
        front = next(
            (
                (w.get("kCGWindowNumber"), w.get("kCGWindowOwnerPID"))
                for w in windows
                if w.get("kCGWindowLayer") == 0
            ),
            None,
        )
        if front is not None and front != self.last_window:
            self.emit({"t_ns": now, "ev": "window"})
            self.last_window = front
        session = Q.CGSessionCopyCurrentDictionary() or {}
        locked = bool(session.get("CGSSessionScreenIsLocked", False))
        if self.last_locked is not None and locked != self.last_locked:
            self.emit(
                {
                    "t_ns": now,
                    "ev": "os",
                    "event": "screen_locked" if locked else "screen_unlocked",
                }
            )
        self.last_locked = locked
        if now - self.last_watchdog >= 5 * NS:
            if not Q.CGEventTapIsEnabled(self.tap):
                Q.CGEventTapEnable(self.tap, True)
            self.last_watchdog = now
        # Bounded retention: raw positions/class events cannot remain in memory >60s.
        while self.queue and self.queue[0]["t_ns"] < now - 60 * NS:
            self.queue.popleft()
            self.dropped += 1

    def start(self):
        import Quartz as Q
        from AppKit import (
            NSWorkspace,
            NSWorkspaceDidActivateApplicationNotification,
            NSWorkspaceWillSleepNotification,
            NSWorkspaceDidWakeNotification,
        )
        from Foundation import NSTimer, NSDistributedNotificationCenter

        self.Q = Q
        if not preflight():
            raise PermissionError(
                "Grant Input Monitoring to the launching Terminal app, then restart Terminal"
            )
        self.secure = secure_input()
        kinds = [
            Q.kCGEventKeyDown,
            Q.kCGEventKeyUp,
            Q.kCGEventFlagsChanged,
            Q.kCGEventMouseMoved,
            Q.kCGEventLeftMouseDown,
            Q.kCGEventLeftMouseUp,
            Q.kCGEventRightMouseDown,
            Q.kCGEventRightMouseUp,
            Q.kCGEventOtherMouseDown,
            Q.kCGEventOtherMouseUp,
            Q.kCGEventLeftMouseDragged,
            Q.kCGEventRightMouseDragged,
            Q.kCGEventOtherMouseDragged,
            Q.kCGEventScrollWheel,
        ]
        mask = sum(1 << k for k in kinds)
        self.tap = Q.CGEventTapCreate(
            Q.kCGSessionEventTap,
            Q.kCGHeadInsertEventTap,
            Q.kCGEventTapOptionListenOnly,
            mask,
            self.callback,
            None,
        )
        if self.tap is None:
            raise PermissionError(
                "Event tap creation failed; restart the app after granting Input Monitoring"
            )
        source = Q.CFMachPortCreateRunLoopSource(None, self.tap, 0)
        Q.CFRunLoopAddSource(Q.CFRunLoopGetCurrent(), source, Q.kCFRunLoopCommonModes)
        Q.CGEventTapEnable(self.tap, True)
        self.timer = NSTimer.scheduledTimerWithTimeInterval_repeats_block_(
            0.5, True, self.poll_system
        )
        center = NSWorkspace.sharedWorkspace().notificationCenter()
        self.observers.append(
            (
                center,
                center.addObserverForName_object_queue_usingBlock_(
                    NSWorkspaceDidActivateApplicationNotification,
                    None,
                    None,
                    self.app_changed,
                ),
            )
        )
        for name, event in [
            (NSWorkspaceWillSleepNotification, "sleep"),
            (NSWorkspaceDidWakeNotification, "wake"),
        ]:
            self.observers.append(
                (
                    center,
                    center.addObserverForName_object_queue_usingBlock_(
                        name,
                        None,
                        None,
                        lambda note, e=event: self.emit(
                            {"t_ns": time.monotonic_ns(), "ev": "os", "event": e}
                        ),
                    ),
                )
            )
        dc = NSDistributedNotificationCenter.defaultCenter()
        for name, event in [
            ("com.apple.screenIsLocked", "screen_locked"),
            ("com.apple.screenIsUnlocked", "screen_unlocked"),
        ]:
            self.observers.append(
                (
                    dc,
                    dc.addObserverForName_object_queue_usingBlock_(
                        name,
                        None,
                        None,
                        lambda note, e=event: self.emit(
                            {"t_ns": time.monotonic_ns(), "ev": "os", "event": e}
                        ),
                    ),
                )
            )
        self.app_changed()

    def run(self, seconds=None):
        if self.tap is None:
            self.start()
        end = time.monotonic() + seconds if seconds is not None else float("inf")
        while self.running and time.monotonic() < end:
            self.Q.CFRunLoopRunInMode(self.Q.kCFRunLoopDefaultMode, 0.25, False)

    def close(self):
        self.running = False
        if hasattr(self, "timer"):
            self.timer.invalidate()
        for center, observer in self.observers:
            center.removeObserver_(observer)
        if self.tap is not None:
            self.Q.CGEventTapEnable(self.tap, False)
