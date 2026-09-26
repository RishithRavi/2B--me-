# macOS probe — 2026-09-26

Executed `PYTHONPATH=agent work/venv/bin/python -m twobme_agent.cli doctor --seconds 5` in this Codex host.

| Check | Observed |
|---|---|
| `CGPreflightListenEventAccess` (ctypes) | true |
| Listen-only session event tap creation | succeeded |
| `CGEventTapIsEnabled` | true |
| Events during five-second probe | 0 — **not verified** |
| Secure Event Input | **enabled** |
| Mach timebase | 125/3 (41.6666667) |
| CGEvent timestamp units | **unverified** without arriving events; runtime calibrator selects ns/Mach scaling from elapsed samples |
| Mouse event rate | **unverified**; zero observed during idle probe |

Doctor correctly exited 1. For live acceptance, launch from Terminal.app with Input Monitoring, turn off Secure Keyboard Entry, move/type during the probe, and rerun. No personal event log was written by this probe. Distributed lock/sleep notification delivery, mouse rate, and timestamp calibration remain hardware acceptance checks.

## Successful human activity check — 2026-09-26 05:48 UTC

Launched the real `Capture` implementation through `scripts/sig_probe_live.py` in a Codex shell PTY for 60.07 seconds while the user typed, moved/clicked the trackpad, scrolled and changed apps. No raw event log or network transmission was made.

- Input Monitoring: true; tap enabled: true.
- Secure Event Input: false at start and end.
- 192 key-downs and 192 key-ups; 1,045 pointer movements; 23 click-downs; 260 user scroll events plus 17 momentum events.
- 1,757 native events total; zero queue drops.
- Event-clock elapsed calibration selected native nanoseconds (factor 1.0); Mach timebase remains 125/3.
- Keyboard, pointer and scroll capture: **verified** in this launch context.
- Terminal.app UI automation was blocked by the computer-use tool, so this verifies the Codex-launched process, not a distinct Terminal.app TCC grant. Lock/sleep delivery and the integrated server/trust flow remain separate checks.

Aggregate report: `work/live-capture-check.json`, also copied to the user-facing outputs. The earlier failed idle/Secure Event Input probe is retained above for provenance.
