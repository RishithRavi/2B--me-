# A/B recordings and five takeover trials

## Hackathon fast path — recommended for the current time budget

The hour-per-person plan below is for a fuller five-modality evaluation. It is **not required for a narrower owner-vs-teammate demo**.

1. Record **A while A continues normal hackathon work**, aiming initially for 15–20 active minutes with typing, pointer use and scrolling. At the measured 192 key-downs/minute, 2,000 keys take about 10.4 active minutes; roughly 3,000+ keys plus a purge buffer are needed if also reserving a 30% evaluation holdout. Actual block gates, not the clock, determine readiness. This is an estimate, not an accuracy guarantee.
2. Have **B spend 3–5 minutes** on the same laptop doing a similar mix of notes, pointer movement/clicks and scrolling, naturally. B is held-out impostor data for A's anomaly detector; B does not need a second enrolled identity for this demo. Two-way identification stays unreported until B has enough data.
3. Train/evaluate the supported modalities. Keep the existing enrollment gates. Keyboard, and mouse if it fills its gate, are the initial candidates; other underfilled branches remain disabled. Do not fill a gate with copies or jittered versions of the same observations. Partial-modality enrollment must be reflected honestly in the integrated UI.
4. Check a later A segment and B's recording before the live demo. A tiny pilot can fail to separate the people. If that happens, collect a targeted top-up rather than fabricating confidence changes. Five controlled final takeover trials remain a separate acceptance milestone; a shorter live demonstration can be shown with its actual trial count disclosed.
5. Save the real A/B recordings locally as a reproducible **recorded-behavior replay** fallback. Clearly label it as replay. Replaying a recording does not create additional independent evaluation samples.

`twobme-ml eval` now supports a short B recording when B cannot pass enrollment gates: it still reports A-model genuine/impostor metrics, leaves two-way identification accuracy null, and notes the limitation. A still needs sufficient genuine training plus holdout data.

Synthetic fixtures remain useful for plumbing, UI and fault tests. They are not personal enrollment data. A separate published-human benchmark could test an algorithm, but the current project restricts impostor data to teammates, and an external corpus does not establish A's identity or transfer unchanged into our feature schema. No external dataset or synthetic sample has been added to the owner's baseline.

## Principle

A is the owner and enrolled identity; B is the teammate playing an impostor. Use the **same laptop, keyboard, trackpad, display setup and browser profile**. Both people perform the same kinds of activities, in their own natural way. Do not try to type at a fixed speed, avoid mistakes, imitate each other, or deliberately act unusually. Use fresh text and normal variations on each repetition.

This is a two-person demo evaluation, not evidence that the model generalizes to every attacker or context.

## 1. Confirm capture first

From the repository's Python 3.12 environment:

```sh
work/venv/bin/python scripts/sig_probe_live.py --seconds 60 --output work/live-capture-check.json
```

During the minute: type and correct harmless text in a scratch editor, move and click the trackpad, scroll a long page, and switch apps. The diagnostic only prints counts and hardware state; it writes no class/position event log and sends nothing over the network. Expect positive key-down/key-up, pointer/click and scroll counts, an enabled tap, and Secure Event Input off.

Terminal.app itself must have Input Monitoring if you launch there; a passing check launched by Codex does not verify Terminal.app's separate permission. Restart the launching app after granting its permission. Turn off Terminal's Secure Keyboard Entry if it is on. Do not type passwords into the practice editor.

## 2. Optional fuller evaluation: record A and B separately

Start with **about 60 active minutes per person**, broken into comfortable sessions if necessary. This is a starting collection target, not a guarantee that every modality will pass. Keep recording/top up underfilled modalities based on actual block counts. The 30% held-out evaluation leaves only 70% for training: getting 60 non-overlapping temporal windows in that training portion alone takes roughly 43 active minutes before purge/gap losses.

Use the same approximate task mix for both people:

| Activity | Initial target | What to do naturally |
|---|---:|---|
| Ordinary work | 30 min | Read, write notes, use the editor/browser/Terminal, pause, correct text and switch between apps as needed. This supplies natural-use calibration data. |
| Demo checkout choreography | 15 min | Standing at the table-height laptop, browse products, scroll the dashboard, type a fictional shipping address and a two-sentence gift note, move among two product pages and return to the cart. Use the mock shop when available; until then, practice the equivalent typing/clicking/scrolling in a scratch document/browser. Do not make real purchases. |
| Balanced top-up | 15 min | Alternate short notes, reading/scrolling and pointer tasks such as selecting text, clicking targets and dragging a harmless window. Switch between your usual apps. Top up the weakest collection gates. |

Run one recorder at a time; stop it with Ctrl-C before switching people:

```sh
# A only:
work/venv/bin/twobme-agent record --label genuine --actor a

# Stop A's recording. Now B uses the same laptop:
work/venv/bin/twobme-agent record --label impostor --actor b
```

Keep the printed file paths. The real logs remain under `~/.2bme/logs/` on the laptop and are never committed/uploaded. B's recording is evaluation/calibration data; it must not enter A's enrollment baseline. For the separate two-way identification experiment, B can have a separate model trained from B's own designated training split.

Collection gates for A's eligible training data: keyboard 100 blocks (~2,000 keys), mouse 60 (~300 actions), scroll 30, workflow 13 (minutes with an app or window change), temporal 60 non-overlapping 30-second contexts. Time alone does not fill a gate, and chronological calibration also needs enough span around purge gaps.

Reserve the last 30% of each person's data for chronological evaluation. Do not train on those held-out rows or tune repeatedly against them. Keep the later live takeover trials separate from training. For honest final trials, freeze the chosen model and thresholds first; record every trial, including misses.

## 3. Five live takeover trials — after backend integration

The live dashboard, marker endpoint, model activation and voice/MFA recovery must be working. Today, local capture can be verified independently; the entire takeover flow still depends on the other workstreams.

For each trial:

1. Activate A's trained model and authenticate/anchor A through the approved flow. Record the model version and starting confidence. A works naturally for 1–2 minutes; use a comparable starting confidence across trials and keep initial setup out of the measured interval.
2. At the handoff, B uses the **observer laptop** to mark `takeover_start` just before touching A's laptop. With only one laptop, A marks at the moment of handoff using `twobme-agent mark` (or ⌃⌥⌘M). State which method was used; handoff delay affects the stopwatch.
3. A stops touching the keyboard/trackpad. B takes over the same unlocked OS/browser session on the same laptop. Do **not** log B into another account or reset trust at takeover.
4. B performs the rehearsed checkout task at their normal pace: edit the fictional address, write a fresh two-sentence gift note, visit two product pages, return to the cart and scroll. The plan aims for ~150 keystrokes and ~15 mouse actions in ~45 seconds; this is rehearsal guidance, not a prescribed typing rate.
5. Continue until the proactive challenge is armed (two consecutive 5-second ticks below 0.40), or until 300 seconds. Record the arming timestamp, not just when someone notices a modal. No detection by 300 seconds is a miss; retain it.
6. Mark `takeover_end` after B stops. A verifies through the owner voice/MFA recovery flow before resuming owner activity. A takeover-end marker alone must not clear contaminated training eligibility; quarantine lasts until verified recovery. Prepare the next trial with A, keeping reset/recovery actions outside the measurement.

Repeat five times with fresh content but the same task mix. Use the same model, hardware and thresholds. The spec's live behavioral target is **median arming TTD ≤60 seconds**; keep all five detection/miss outcomes visible. Do not discard unsuccessful runs to improve that median.

A mock checkout during takeover is a separate policy test. The expected low-trust result is **C / challenge**, not an immediate behavioral block. A final Y/N depends on voice/MFA and backend policy. A deliberate demo reset/re-arm is operator intervention, never evidence that the model detected a takeover.

Also keep a separate 30-minute A-only session to measure false challenges/friction; five successful attacker trials alone say nothing about how often the owner gets challenged.

## 4. Live record sheet

| Trial | Model version | Starting confidence | Handoff/marker time | Arming time | TTD seconds | Detected by 300s? | Owner recovery / notes |
|---|---|---:|---|---|---:|---|---|
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |
| 4 | | | | | | | |
| 5 | | | | | | | |

The evaluator accepts `markers: [{t,label}]` and `ticks: [{t,confidence}]` with UTC timestamps. The backend supplies these once integrated. Keep training recordings and trial logs distinctly labelled. Never mark synthetic/replayed behavior as a real live human trial.
