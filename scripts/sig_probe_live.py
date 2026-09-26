#!/usr/bin/env python3
"""Short live capture diagnostic: aggregate counts only, no event log or network."""

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
from twobme_agent.capture import Capture, preflight, secure_input


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=float, default=60)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    cap = Capture(ROOT / "contracts")
    counts = Counter()
    result = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "input_monitoring": preflight(),
        "secure_input_at_start": secure_input(),
    }
    started = time.monotonic()
    next_status = started + 10
    print(
        "LIVE CHECK: type harmless text in an editor, move/click the trackpad, scroll, and switch apps. No event log is saved.",
        flush=True,
    )
    try:
        cap.start()
        while time.monotonic() - started < args.seconds:
            cap.run(0.25)
            while cap.queue:
                e = cap.queue.popleft()
                if e["ev"] == "key":
                    if e["cls"] not in {
                        "SHIFT",
                        "CMD",
                        "CTRL",
                        "OPT",
                        "CAPS",
                    } and not e.get("autorepeat"):
                        counts["key_downs" if e["down"] else "key_ups"] += 1
                        if e.get("inj"):
                            counts["key_events_flagged_injected"] += 1
                elif e["ev"] == "mouse":
                    counts[
                        "pointer_moves"
                        if e["kind"] in ("move", "drag")
                        else "click_downs"
                        if e["kind"] == "down"
                        else "click_ups"
                    ] += 1
                    if e.get("inj"):
                        counts["pointer_events_flagged_injected"] += 1
                elif e["ev"] == "scroll":
                    counts[
                        "scroll_events" if not e.get("momentum") else "momentum_events"
                    ] += 1
                elif e["ev"] in ("app", "window", "secure_input"):
                    counts[e["ev"] + "_events"] += 1
            if time.monotonic() >= next_status:
                print(
                    json.dumps(
                        {
                            "elapsed_s": round(time.monotonic() - started),
                            "secure_input": secure_input(),
                            "counts": dict(counts),
                        }
                    ),
                    flush=True,
                )
                next_status += 10
        result.update(
            tap_enabled=bool(cap.Q.CGEventTapIsEnabled(cap.tap)),
            native_event_count=cap.n_events,
            timestamp_factor=cap.clock.factor,
            timestamp_calibrated=bool(
                cap.clock.first and cap.last_event_ns - cap.clock.first[1] > 0.5e9
            ),
            mach_timebase=cap.clock.timebase,
            dropped_events=cap.dropped,
        )
    except KeyboardInterrupt:
        result["interrupted"] = True
    except (PermissionError, OSError) as exc:
        result["capture_error"] = str(exc)
    finally:
        cap.close()
    result.update(
        elapsed_s=round(time.monotonic() - started, 2),
        secure_input_at_end=secure_input(),
        counts=dict(counts),
    )
    result["keyboard_verified"] = counts["key_downs"] > 0 and counts["key_ups"] > 0
    result["pointer_verified"] = (
        counts["pointer_moves"] > 0 and counts["click_downs"] > 0
    )
    result["scroll_verified"] = counts["scroll_events"] > 0
    result["ok"] = (
        not result.get("interrupted", False)
        and all(
            result[k]
            for k in ("keyboard_verified", "pointer_verified", "scroll_verified")
        )
        and not result["secure_input_at_end"]
    )
    text = json.dumps(result, indent=2)
    print(text, flush=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
