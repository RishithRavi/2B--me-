# 2Bme: know who's really at the keyboard

> **Your session can stay the same even when the person using it changes. 2Bme looks for that change.**

**Live:** [2bme.tech](https://2bme.tech) · **Event:** HackGT 13

---

## The problem, in one minute

You step away from your laptop for a minute. Someone else sits down. Your email is open. Your accounts are signed in. They can pick up right where you left off.

That handoff is the problem we're working on. A successful login doesn't tell an app who is using the session ten minutes later.

It matters beyond a borrowed laptop. A stolen session can give someone access to a small business's email or a coworker's account. A remote-access scam can put a stranger in control of a family member's computer. By the time anyone notices, they may already be trying to move money or read something private.

The stakes are real: the FBI's IC3 recorded **$2.9 billion in reported business email compromise losses** and **$3.4 billion in reported losses among people over 60** in 2023. Those figures cover a broader set of scams than we can address; our focus is the moment someone else takes over an authenticated session. [Source: FBI IC3](https://www.ic3.gov/media/IC3-Brochure.pdf).

**Could a computer notice that handoff without reading what you type?** That's the question behind 2Bme.

## Our answer

**2Bme learns the rhythm of how you use your computer.** Your typing has a pace. Your mouse movements and scrolling have patterns. We use those signals to update a live **trust score** as you work, looking for activity that doesn't fit your usual behavior.

When the pattern changes, trust can fall. In our checkout flow, a risky action such as a $2,000 purchase then requires a **voice check** or a one-time code before it can proceed.

Think of a bank teller who knows you well enough to notice when something feels off and ask one more question. That's the role we're exploring for software: notice a change while there's still time to check.

## The demo: what judges will see

| Step | What happens | What you see |
|---|---|---|
| 1. **Enroll** | The owner uses the laptop normally while 2Bme learns their behavior. | An identity card with a model version |
| 2. **Normal use** | The owner keeps working. | The trust score stays high (green) |
| 3. **Takeover** | A teammate sits down and starts using the same laptop. | Trust falls in real time, with "why" chips such as *typing rhythm unusual* |
| 4. **Risky action** | The intruder tries a $2,000 checkout. | The purchase is paused and a voice challenge appears |
| 5. **Voice check** | ElevenLabs speaks a random phrase and the person repeats it. | **VERIFY** (owner), **BLOCK_IMPOSTOR** (wrong voice) or **BLOCK_SPOOF** (AI-cloned voice) |
| 6. **Lock** | A failed check locks the Mac. | A full-screen lock from the on-laptop overlay |
| 7. **Org view** | The security team opens `/admin`. | A synthetic employee roster illustrating session anomalies and an audit trail |

**Behavior alone never blocks anyone.** A low score asks for more proof: voice, or a one-time code (TOTP) as a fallback. People get tired, switch tasks, and have off days. An unusual typing rhythm is a reason to check, not a verdict about who they are.

## Privacy is part of the product

We measure **timing, not content.** 2Bme never records:

- what you type, or passwords
- clipboard contents or document text
- window titles, URLs or app names
- which keys you press (keys are reduced to "left hand / right hand / space / digit" on the laptop, then discarded)

For behavioral scoring, only summary statistics leave the laptop, such as the median gap between keystrokes in a block of activity. The dashboard has a **"What left this laptop"** viewer that shows the data sent. The merge gate includes an automated privacy check (`scripts/check_privacy.sh`) for prohibited capture and serialization patterns.

Voice: *"Our server deletes challenge audio after scoring and stores only embeddings and scores. ElevenLabs processes the prompt and STT audio and, on our plan, retains it in account history (Zero Retention is enterprise-only). `STT_BACKEND=local` avoids this."*

## How it works

```
  ┌──────────── Your Mac ────────────┐        ┌────────── Cloud (Vultr) ──────────┐
  │ keyboard · mouse · scroll · apps │        │                                   │
  │            │                     │        │  Trust engine ──▶ live trust score│
  │  timing only, no content         │  wss   │        │                          │
  │            ▼                     │ ─────▶ │        ├──▶ Tiger Data (history)  │
  │  privacy-safe summary blocks     │        │        └──▶ Voice step-up         │
  │                                  │ ◀───── │             (ElevenLabs + anti-   │
  │  Overlay: trust pill → voice     │ trust, │              spoof + speaker ID)  │
  │  check → lock screen             │ lock   │                                   │
  └──────────────────────────────────┘        └──────────────┬────────────────────┘
                                                             ▼
                                   2bme.tech: dashboard · shop · lab · admin
```

1. **Capture.** A small macOS agent watches input *timing* and turns it into summary blocks without typed content.
2. **Score.** The server compares each block with the owner's learned profile and updates a trust score every few seconds.
3. **Step up.** When trust is low and the action is risky, the user gets a voice challenge.
4. **Remember.** Scores, anomalies and challenges form a time-series history, so a security team can investigate when a session's behavior changed.

The behavioral model trains on the owner's activity, so enrollment doesn't need a database of other people's habits. It looks for deviations from that baseline. Restricting which activity can update the baseline is intended to reduce the risk of learning an intruder's behavior as normal.

Our work connects the macOS capture agent, timing features, owner-specific model, trust engine, checkout policy and user interfaces. The voice layer combines existing speaker and anti-spoof models with our challenge flow; ElevenLabs provides speech generation and transcription. The engineering challenge is making those pieces support a useful decision while keeping typed content out of the pipeline.

---

## Hackathon tracks

### 🌊 Oracle of the Deep: AI/ML behavioral fingerprinting
2Bme is an ML system that learns one person's **behavioral fingerprint** from about 80 privacy-safe timing features across keyboard, mouse and scroll (app switching and idle patterns are captured as context). It combines them into a **continuous trust score**. A one-class, owner-only detector with cross-conformal scoring decides how "owner-like" each window of activity is. A fusion engine weighs each input type by how much evidence it has seen. The `/lab` page shows the evidence: owner-vs-intruder error rates for each input type, ablations, and time-to-detection.

### 🛟 Aramco, A Marina's Mission: security as social good
For a small business, a compromised account can mean a missed payroll. For a family, it can mean hours spent trying to recover money and wondering who else has access. We want protection that asks less of people during normal use and notices when something changes. This prototype explores that through behavioral checks and a voice-or-code fallback. Testing with the people we hope to help, including people whose movement or speech varies, is an essential next step.

### 💳 Visa, Reimagine Shopping: frictionless when trusted, step-up when not
The `/shop` demo has a $2,000 checkout that returns a 3-D-Secure-style result:
- **High trust:** **Y**, approved with no extra steps.
- **Low trust or a remote session:** **C**, a challenge, then **Y** (verified) or **N** (declined).

The two scenarios are a thief at the same laptop and a stolen cookie replayed from another machine. The goal is fewer interruptions during normal shopping, with an extra check when the session looks wrong. Trust scores are model outputs, not measured accuracy percentages. *(The checkout is a clearly labelled demo scenario and is not affiliated with Visa.)*

### 🗣️ ElevenLabs: voice challenges and deepfake red-teaming
The voice flow uses **ElevenLabs** to speak a random phrase and **ElevenLabs Scribe** to check the response. The verifier combines DSP/FFT spectral features, an ECAPA speaker embedding and a deepfake detector. Our red-team scenario uses consented clones of our own voices to test whether a familiar-sounding voice can fool the check. Clone detection needs measured validation; a convincing demo alone isn't evidence of reliability.

### 🐯 Tiger Data: behavior over time
Behavior is naturally time-series data: thousands of timestamped blocks per hour. Tiger Data (TimescaleDB) stores all of it using **hypertables**, **columnstore compression** and a **`trust_1m` continuous aggregate** for fast one-minute rollups. It powers the `/history` page, owner baselines, anomaly lookback, and the admin audit trail showing how trust changed over a session. The live scoring loop never waits on the database. Tiger is the memory, not the hot path.

### ☁️ Vultr: real-time inference in the cloud
The whole backend runs on a **Vultr** VM: the FastAPI hub, trust engine, ML scoring and voice verification behind Caddy with TLS at 2bme.tech. Laptops stream behavior blocks over a secure WebSocket and get a trust score back every ~5 seconds. **Vultr Serverless Inference** writes plain-English, two-sentence explanations of anomalies from feature statistics only, never raw data.

### 🌐 .tech
**[2bme.tech](https://2bme.tech)** brings the project, trust dashboard and privacy explanation together. The name is the question at the heart of the project: what does it take to be me?

---

## What's built

| Area | Status |
|---|---|
| macOS agent (keyboard, mouse, scroll, app-switch timing; no content) | ✅ |
| Live trust score + dashboard with "why" chips | ✅ |
| Owner enrollment and one-click retraining | ✅ |
| Voice step-up (ElevenLabs prompt + STT, speaker match, anti-spoof, DSP/FFT) | ✅ |
| TOTP fallback | ✅ |
| $2,000 checkout with Y / C / N outcomes | ✅ |
| On-laptop overlay: trust pill → voice check → lock screen | ✅ |
| Tiger Data history, compression and continuous aggregates | ✅ |
| `/admin` org view: roster, anomalies, audit trail (synthetic, anonymized demo employees) | ✅ |

This is a hackathon prototype. The [saved behavioral evaluation](reports/eval.json) contains preliminary results from a few real recordings; it does not establish reliability across users or complete the planned live takeover trials. The separate offline stage mode uses scripted trust changes and operator-selected voice verdicts for presentation. Those sequences are not measured detection results.

## Pages to visit

| Page | What it shows |
|---|---|
| [`/`](https://2bme.tech) | The pitch and the privacy promise |
| `/dashboard` | The live trust gauge, per-input bars and "What left this laptop" |
| `/shop` | The $2,000 checkout step-up |
| `/verify` | The voice challenge |
| `/lab` | Behavioral evaluation results and their limitations |
| `/history` | Trust over time, from Tiger Data |
| `/admin` | The security team's org-wide view |

---

## For developers

### Repo map
| Path | What |
|---|---|
| `agent/` | macOS capture agent (Python + PyObjC) |
| `packages/features`, `packages/ml` | Feature extraction, models, TrustEngine |
| `packages/common` | `twobme_common`: shared pydantic DTOs, spec loader, config |
| `server/` | FastAPI hub, policy, Tiger writer/history, auth, voice |
| `web/` | Next.js static site (landing, dashboard, history, lab, shop, verify, enroll, overlay, admin) |
| `overlay/` | Electron on-laptop overlay |
| `infra/` | Docker Compose, Caddy, migrations, deploy |
| `contracts/` | Frozen contracts: feature spec, trust config, WS/REST docs, schemas, fixtures |
| `packages/hearsay` | Voice verification and anti-spoof utilities |

### Quickstart
```bash
uv sync --all-packages                                   # Python 3.12 workspace
docker compose -f infra/docker-compose.dev.yml up -d db  # local TimescaleDB-HA on :5433
TIGER_DATABASE_URL=postgres://postgres:postgres@localhost:5433/tsdb COOKIE_SECURE=false \
  uv run uvicorn app.main:app --app-dir server --port 8000
cd web && corepack pnpm i && corepack pnpm dev           # http://localhost:3000 (proxies /api to :8000)
scripts/gate.sh core                                     # merge gate
```
Contracts: edit `packages/common/src/twobme_common/types.py` or `contracts/*.yaml`, then run
`uv run python scripts/core_gen_ts.py` (regenerates `web/src/lib/contracts.ts` + report schemas).

Deeper design notes: [`IMPLEMENTATION.md`](IMPLEMENTATION.md).

---

*The Visa-style checkout is a clearly labelled demo scenario and is not affiliated with Visa. `/admin`'s employee roster is synthetic, anonymized demo data generated in the browser. It contains no real person's behavior.*
