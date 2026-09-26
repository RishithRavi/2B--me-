# Class-level event log v1 (§5.1.7)

Used by the recorder (`twobme-agent record`), `replay`, `features_from_events`, fixtures and parity tests.
JSON Lines, one object per line. **Never** contains keycodes, key identities, bundle IDs, window titles or URLs.
Local logs live in `~/.2bme/logs/*.jsonl` on A's laptop only: never uploaded, committed or used as fixtures.
Committed fixtures (`contracts/fixtures/events/`) are synthetic (Codex 1's generator).

Line 1 (header):
```json
{"ev":"header","schema_version":1,"display":{"w_pt":1512,"h_pt":982,"hz":120},"pointer":"trackpad","label":"genuine","actor":"a"}
```

| ev | fields | notes |
|---|---|---|
| `key` | `t_ns, down, slot, cls, autorepeat, inj` | `cls` ∈ key_classes (feature_spec `enums.key_classes`). `slot` is a per-run counter reused for the matching key-up — **never the keycode**. |
| `chord` | `t_ns, kind` | `kind` ∈ `tab_new, tab_close, tab_jump, tab_cycle, app_switch_kbd, window_cycle, other_cmd` |
| `mouse` | `t_ns, kind: move|down|up|drag, x_pt, y_pt, button, inj` | coordinates exist only in local logs; committed fixtures are synthetic |
| `scroll` | `t_ns, dy, dx, continuous, phase, momentum` | user event ⇔ `momentum == 0` |
| `app` | `t_ns, cat, via: cmdtab|click|other` | `cat` ∈ app_categories |
| `window` | `t_ns` | window change (number/PID only; never titles) |
| `os` | `t_ns, event: screen_locked|screen_unlocked|sleep|wake` | |
| `secure_input` | `t_ns, on` | keyboard is *missing*, not anomalous |
| `label` | `t_ns, label, actor` | takeover hotkey toggles |

`t_ns`: calibrated agent-monotonic ns for native events; `performance.now()·1e6` for the browser.

Agent hotkeys ⌃⌥⌘M and ⌃⌥⌘R are consumed by the agent and excluded from features.
