# 2bME signals agent — Codex 1

This branch implements §7 P0. It does not implement the server, policy, voice service, shop, deployment, or P1 browser scoring. Read `INTEGRATION.md` for the exact integration dependencies and current acceptance status.

## Install after CP0 integration

Python 3.12 is required. From the integrated repository, install `packages/common`, `packages/features`, `packages/ml`, and `agent` through Claude's uv workspace. Each owned package has its own `pyproject.toml` and console entry point. The agent must run from the repository root, or pass `--contracts /absolute/path/to/contracts`.

For a local development environment without the root workspace:

```sh
uv venv --python 3.12 work/venv
uv pip install --python work/venv/bin/python -e packages/common -e packages/features -e packages/ml -e agent
```

The original checkout contains no `packages/common`; install it only after the core agent publishes it. Do not ship the test contract shim.

## macOS permissions and probe

1. Grant **Input Monitoring to Terminal.app** in System Settings → Privacy & Security. Both keyboard and pointer access are needed.
2. Restart Terminal after changing permissions. Always launch from that same application.
3. Turn **Secure Keyboard Entry off** in Terminal's menu. Password entry is excluded while macOS Secure Event Input is active.
4. Run `twobme-agent doctor`, move the pointer and type during the five-second probe.
5. Read `PROBE.md` for the actual result on this host. Tap creation alone is not proof of capture.

After the event, revoke the grant with:

```sh
tccutil reset ListenEvent com.apple.Terminal
```

## Record locally first

```sh
twobme-agent record --label genuine --actor a
# Stop with Ctrl-C; have B use a separate labeled recording:
twobme-agent record --label impostor --actor b
```

Files are created with mode 0600 under `~/.2bme/logs/`. Only hand-level classes, transient slot counters, local positions, and app categories are recorded. No typed content, native key identities, app identifiers, titles, URLs, clipboard, or audio is recorded. Local position/class logs are never uploaded or committed. Delete them after the event.

## Pair and monitor

```sh
twobme-agent pair --email a@
twobme-agent run --mode enroll --record
# After activating a trained model:
twobme-agent run --mode monitor
```

The device token is stored in Keychain. SQLite stores aggregate ticks only, with per-run/sequence idempotency, original session identity, and bounded capacity. WebSocket disconnects fall back to HTTPS; successful HTTP responses acknowledge that batch. Trust acknowledgements remove current-run rows. Reconnecting does not anchor trust.

The live panel shows server trust, level, transport state, capture drops and modality contributions. A challenge produces a native notification; opening `/verify` requires an explicit server indication that there has been no recent bound browser. Lock does not invoke OS sleep or lock commands.

- **⌃⌥⌘M** toggles takeover markers; **⌃⌥⌘R** sends demo reset. These keys are excluded from feature extraction. A listen-only tap does not suppress the shortcut in other applications.
- `twobme-agent mark` / `twobme-agent mark --end` send markers through the running agent's private Unix socket.

## Replay / offline training / evaluation

```sh
twobme-agent replay --log /path/a.jsonl --then /path/b.jsonl --at 120
twobme-agent replay --log /path/night.jsonl --speed 4 --mode enroll

twobme-ml train --from-logs /path/a.jsonl --output data/models/owner-v1
twobme-ml train --from-parquet /path/eligible.parquet --output data/models/owner-v1
twobme-ml train --from-db --user-id USER_UUID --output data/models/owner-v1

twobme-ml eval --from-logs /path/a.jsonl /path/b.jsonl --live-evidence /path/trials.json --output reports/eval.json
# CP1 real night evaluation uses the same command with --output data/eval/night.json
```

`--speed > 1` requires enroll mode; it is ingestion only, never a live trust demonstration. Replay rebases the log's monotonic start to the current wall clock. For trustworthy offline temporal evaluation, evaluate the original logs, not accelerated network timestamps.

`TIGER_DATABASE_URL` is needed only for `--from-db`. No server or Tiger is needed for `--from-logs`. Calibration needs enough chronological coverage for all five purged folds in addition to each active modality's enrollment gate. The identity model uses keyboard, mouse and scroll; workflow and temporal remain wire-compatible but are not scored. Underfilled active modalities are explicitly disabled, and training refuses to emit an empty model. Load joblib artifacts only from trusted local storage.

Live evidence is a JSON object with `markers: [{t,label}]` and `ticks: [{t,confidence}]`. TTD requires two consecutive ticks below .40 and is bounded by the trial end/300 seconds. Supply at least five actual trials. The committed report is an honest pending-data report, not a synthetic claim about A/B.

## Stage checklist (human-operated)

`twobme-agent doctor --stage` requires active capture, no Secure Event Input, trackpad/no external USB mouse, Chrome default, Bluetooth off, backend RTT <300ms, warmed voice and >5,000 ElevenLabs characters. Unknown checks fail. Confirm the physical pointing device independently; generic HID names cannot prove that no external pointer exists.

Use the demo choreography and trackpad, disable Bluetooth, auto-lock and screen saver, and set `pmset displaysleep 0` manually before the expo. This implementation deliberately does not change these machine settings. Launch in the same Terminal window under `caffeinate -dimsu` with your team's restart loop.

## Verification before the shared gate exists

```sh
uv pip install --python work/venv/bin/python numpy scipy scikit-learn pandas pyarrow joblib pyyaml pytest hypothesis httpx websockets keyring rich pydantic
work/venv/bin/python scripts/sig_test.py -q -s
PYTHONPATH=packages/features:packages/ml:agent:scripts work/venv/bin/python scripts/sig_make_fixtures.py --test-contracts
work/venv/bin/python scripts/sig_smoke.py
```

`sig_test.py` installs the test-only DTO shim only when common is unavailable. With CP0 present, it uses real common types. `sig_make_fixtures.py` normally reads the canonical YAML; `--test-contracts` is an explicit pre-CP0 test option. Fixtures are seeded synthetic sequences, never real local logs. `sig_smoke.py` writes only synthetic evaluation assets to `work/`.

The Monte Carlo acceptance test intentionally retains the failing 169/200 result against the required 170/200 threshold. Do not change the seed to make the gate green. Request calibration review and run the shared `scripts/gate.sh` after integration; it is absent from this starting checkout.
