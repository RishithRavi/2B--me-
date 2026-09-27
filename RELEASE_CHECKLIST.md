# Release checklist

This is the short path from a green branch to an honest 2bME demo. It separates checks the repository
can automate from evidence that requires people, hardware, accounts, or production access.

## Automated on every pull request

GitHub Actions runs `.github/workflows/ci.yml`, which installs locked Python, web, and overlay
dependencies and then runs:

```bash
scripts/gate.sh all
pnpm --dir web run build
```

The gate covers the privacy scanner, generated contracts, Python suites, web and overlay tests, and the
Docker/Tiger end-to-end scenario. The end-to-end scenario uses explicit stub voice mode; it proves the
product state machine, not real voice-model accuracy.

## Manual release evidence

### 1. Behavioral identity

Use fresh, consented A/B recordings that were not used to select the model. On the laptop containing
the recording run folder:

```bash
uv run python scripts/sig_gap_compare.py --run-dir /absolute/path/to/run
```

Freeze the chosen model and thresholds, then perform at least five live handoff trials using
`agent/COLLECTION_PROTOCOL.md`. Keep every detected and missed trial. Report time to detection, false
alarms, AUC/EER, model version, and sample counts. The active identity model scores keyboard, mouse,
and scroll; workflow and temporal blocks remain diagnostic and wire-compatible only.

### 2. Public Vultr deployment

Follow `infra/README.md`: point the `.tech` DNS records to the VM, install Docker, clone the merged
`main`, create the VM-only `.env`, and run `infra/deploy.sh`. Confirm HTTPS and both health endpoints
from a different network. Do not call the site live until these checks pass.

Vultr Serverless Inference is optional. Without its API key and model, anomaly explanations use the
deterministic template fallback and `/api/status` reports that fact.

### 3. Voice mode

The reproducible demo uses `VOICE_MODE=stub` and must be described as simulated. For real voice, use
the model-host steps in `infra/README.md`, collect consented calibration audio, generate measured
thresholds, and run the 20 genuine + 20 attack hardware smoke test. Real mode intentionally remains
unhealthy until model pins and calibration are installed.

### 4. Demo rehearsal

Run the full owner → takeover → challenge → block → owner recovery → approved checkout sequence on the
actual demo laptop, microphone, network, and observer screen. Record a backup video only after the live
rehearsal passes.

## Claims boundary

- Privacy-safe aggregate feature blocks leave the laptop; raw key identities, typed content, absolute
  coordinates, application names, and window titles do not.
- Scoring currently runs in the FastAPI service. Do not claim that only risk events leave the device or
  that the identity model itself runs locally.
- The `/admin` roster is synthetic browser-generated demonstration data, not a production multi-tenant
  organization backend.
- Backboard.io is deferred.
