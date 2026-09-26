import json
import subprocess
import time
import httpx
from .capture import Capture, preflight, secure_input


def system_json(kind):
    p = subprocess.run(
        ["system_profiler", kind, "-json"],
        capture_output=True,
        text=True,
        timeout=20,
        check=True,
    )
    return json.loads(p.stdout)


def doctor(contracts="contracts", stage=False, base="https://2bme.tech", seconds=5):
    result = {
        "input_monitoring": preflight(),
        "secure_input": secure_input(),
        "tap_created": False,
        "tap_enabled": False,
        "events_arrived": False,
    }
    cap = Capture(contracts)
    try:
        start = time.monotonic()
        cap.start()
        result["tap_created"] = True
        cap.run(seconds)
        result.update(
            tap_enabled=bool(cap.Q.CGEventTapIsEnabled(cap.tap)),
            events_arrived=bool(
                cap.last_event_ns and time.monotonic_ns() - cap.last_event_ns <= 5e9
            ),
            event_count=cap.n_events,
            mouse_hz=cap.n_moves / max(0.001, time.monotonic() - start),
            timestamp_factor=cap.clock.factor,
            mach_timebase=cap.clock.timebase,
        )
    except (PermissionError, OSError) as exc:
        result["capture_error"] = str(exc)
    finally:
        cap.close()
    if stage:
        try:
            from AppKit import NSWorkspace
            from Foundation import NSURL

            app = NSWorkspace.sharedWorkspace().URLForApplicationToOpenURL_(
                NSURL.URLWithString_("https://2bme.tech")
            )
            result["chrome_default"] = bool(
                app and app.lastPathComponent() == "Google Chrome.app"
            )
        except Exception:
            result["chrome_default"] = False
        try:
            hid = json.dumps(system_json("SPUSBDataType")).lower()
            result["external_mouse_absent"] = "mouse" not in hid
            bt = json.dumps(system_json("SPBluetoothDataType")).lower()
            result["bluetooth_off"] = (
                '"controller_state": "off"' in bt
                or '"controller_state": "attrib_off"' in bt
            )
        except Exception:
            result["external_mouse_absent"] = result["bluetooth_off"] = False
        try:
            start = time.monotonic()
            r = httpx.get(base.rstrip("/") + "/api/status", timeout=5)
            r.raise_for_status()
            status = r.json()
            result["rtt_ms"] = (time.monotonic() - start) * 1000
            result["voice_warm"] = status.get("voice_warm") is True
            result["elevenlabs_remaining"] = status.get("elevenlabs_remaining", 0)
        except (OSError, httpx.HTTPError, ValueError):
            result.update(rtt_ms=None, voice_warm=False, elevenlabs_remaining=0)
        result["pointer_trackpad"] = (
            cap.pointer == "trackpad" and result["external_mouse_absent"]
        )
    result["ok"] = (
        all(
            result[k]
            for k in (
                "input_monitoring",
                "tap_created",
                "tap_enabled",
                "events_arrived",
            )
        )
        and not result["secure_input"]
    )
    if stage:
        result["ok"] &= (
            all(
                result[k]
                for k in (
                    "chrome_default",
                    "external_mouse_absent",
                    "bluetooth_off",
                    "voice_warm",
                    "pointer_trackpad",
                )
            )
            and result["rtt_ms"] is not None
            and result["rtt_ms"] < 300
            and result["elevenlabs_remaining"] > 5000
        )
    return result
