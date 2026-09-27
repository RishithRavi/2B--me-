# 2bME: know who's really at the keyboard

> **A password proves who you *were* when you logged in. 2bME keeps checking who you *are*.**

**Live:** [2bme.tech](https://2bme.tech) · **Event:** HackGT 13

<!-- HEARSAY JUDGE BOX (Codex 2 fills in at C6):
| NSA Hearsay | |
|---|---|
| README | hearsay_submission/README.md |
| Predictions TSV | hearsay_submission/predictions/<TEAM>_predictions.tsv |
| Image | ghcr.io/<org>/2bme-hearsay:<sha> |
| Run | `docker run --rm --network none -v $PWD/test:/data -v $PWD/out:/out ghcr.io/...` |
-->

---

## The problem, in one minute

Once you log in, almost every system trusts you until you log out. The security check happens once, at the front door. After that, nobody asks again.

The costly attacks happen after that check:

- someone sits down at an unlocked laptop
- a stolen session cookie is replayed from another machine
- a scammer "helps" an elderly relative by taking over their computer
- an insider uses a coworker's logged-in account

In the U.S. in 2023, **business email compromise cost companies $2.9 billion**, and **Americans over 60 lost $3.4 billion to cybercrime** (FBI IC3, 2023). In most of these cases the login was valid. The person behind it wasn't.

## Our answer

**2bME is continuous identity.** It learns *how* you use your computer: your typing rhythm, the way you move the mouse, how you scroll, and how you switch between apps. From that it keeps a live **trust score** for as long as you're working.

When someone else takes over, their rhythm doesn't match yours and the trust score drops. If they then try something risky, such as a $2,000 purchase, 2bME asks for a **voice check** before letting it through.

> Think of it like a bank teller who has known you for years. Your ID card never changed, but they can tell it isn't you at the counter.

## The demo: what judges will see

| Step | What happens | What you see |
|---|---|---|
| 1. **Enroll** | The owner uses the laptop normally while 2bME learns their behavior. | An identity card with a model version |
| 2. **Normal use** | The owner keeps working. | The trust score stays high (green) |
| 3. **Takeover** | A teammate sits down and starts using the same laptop. | Trust falls in real time, with "why" chips such as *typing rhythm unusual* |
| 4. **Risky action** | The intruder tries a $2,000 checkout. | The purchase is paused and a voice challenge appears |
| 5. **Voice check** | ElevenLabs speaks a random phrase and the person repeats it. | **VERIFY** (owner), **BLOCK_IMPOSTOR** (wrong voice) or **BLOCK_SPOOF** (AI-cloned voice) |
| 6. **Lock** | A failed check locks the Mac. | A full-screen lock from the on-laptop overlay |
| 7. **Org view** | The security team opens `/admin`. | Every employee session, anomalies and an audit trail of each alert and challenge |

**Behavior alone never blocks anyone.** A low score only asks for more proof: voice, or a one-time code (TOTP) as a fallback. Nobody gets locked out for having an off day.

## Privacy is part of the product

We measure **timing, not content.** 2bME never records:

- what you type, or passwords
- clipboard contents or document text
- window titles, URLs or app names
- which keys you press (keys are reduced to "left hand / right hand / space / digit" on the laptop, then discarded)

Only statistics leave the laptop, such as "median gap between keystrokes in this 10-second window." The dashboard has a **"What left this laptop"** viewer that shows the exact data sent. Every merge runs an automated privacy check (`scripts/check_privacy.sh`) that fails the build if content-bearing data could reach the network.

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

1. **Capture.** A small macOS agent watches input *timing* and turns it into anonymous summary blocks.
2. **Score.** The server compares each block with the owner's learned profile and updates a trust score every few seconds.
3. **Step up.** When trust is low and the action is risky, the user gets a voice challenge.
4. **Remember.** Every score, anomaly and challenge is stored as time-series history, so a security team can trace exactly when a session changed hands.

The model learns **who you are *not***. It trains only on the owner's own behavior and flags anything that doesn't fit, so it needs no database of other people. It also only updates its baseline on activity it's confident is really you. An intruder can't slowly "teach" it their habits.

---

## Hackathon tracks

### 🌊 Oracle of the Deep: AI/ML behavioral fingerprinting
2bME is an ML system that learns one person's **behavioral fingerprint** from about 80 privacy-safe timing features across keyboard, mouse and scroll (app switching and idle patterns are captured as context). It combines them into a **continuous trust score**. A one-class, owner-only detector with cross-conformal scoring decides how "owner-like" each window of activity is. A fusion engine weighs each input type by how much evidence it has seen. The `/lab` page shows the evidence: owner-vs-intruder error rates for each input type, ablations, and time-to-detection.

### 🛟 Aramco, A Marina's Mission: security as social good
Account takeover hurts the people least able to recover: seniors targeted by remote-access scams, small businesses without a security team, and nonprofits that share laptops. 2bME protects them **without asking them to do anything new**. There are no extra passwords and no hardware keys, and nothing changes until someone who isn't them takes over. Because it keeps content private by design, it's safe to deploy for vulnerable users.

### 💳 Visa, Reimagine Shopping: frictionless when trusted, step-up when not
The `/shop` demo has a $2,000 checkout that returns a 3-D-Secure-style result:
- **Trusted owner (~97% confidence):** **Y**, approved instantly with no extra steps.
- **Stolen session (~31% confidence):** **C**, a voice challenge, then **Y** (verified) or **N** (declined).

It covers both attack types: a thief at the same laptop, and a stolen cookie replayed from another machine. Honest shoppers get *less* friction, and fraud still gets stopped. *(The checkout is a clearly labelled demo scenario and is not affiliated with Visa.)*

### 🗣️ ElevenLabs: voice challenges and deepfake red-teaming
When trust drops, **ElevenLabs** speaks a freshly generated random phrase and **ElevenLabs Scribe** checks that the right words were said. A hybrid verifier then checks the voice itself: DSP/FFT spectral features, an ECAPA speaker embedding and a deepfake detector. We also use ElevenLabs as an **attacker**. We clone our own voices and confirm the system returns **BLOCK_SPOOF**. A live clone-attack tool is part of the demo.

### 🐯 Tiger Data: behavior over time
Behavior is naturally time-series data: thousands of timestamped blocks per hour. Tiger Data (TimescaleDB) stores all of it using **hypertables**, **columnstore compression** and a **`trust_1m` continuous aggregate** for fast one-minute rollups. It powers the `/history` page, owner baselines, anomaly lookback, and the admin audit trail showing how trust changed over a session. The live scoring loop never waits on the database. Tiger is the memory, not the hot path.

### ☁️ Vultr: real-time inference in the cloud
The whole backend runs on a **Vultr** VM: the FastAPI hub, trust engine, ML scoring and voice verification behind Caddy with TLS at 2bme.tech. Laptops stream behavior blocks over a secure WebSocket and get a trust score back every ~5 seconds. **Vultr Serverless Inference** writes plain-English, two-sentence explanations of anomalies from feature statistics only, never raw data.

### 🔊 NSA Hearsay
Our voice anti-spoofing work is also entered in NSA Hearsay, with a predictions TSV, a Docker image and a separate README in [`hearsay_submission/`](hearsay_submission/).

### 🌐 .tech
The polished live site at **[2bme.tech](https://2bme.tech)**.

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

## Pages to visit

| Page | What it shows |
|---|---|
| [`/`](https://2bme.tech) | The pitch and the privacy promise |
| `/dashboard` | The live trust gauge, per-input bars and "What left this laptop" |
| `/shop` | The $2,000 checkout step-up |
| `/verify` | The voice challenge |
| `/lab` | Evidence that behavior identifies a person |
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
| `packages/hearsay`, `hearsay_submission/` | Voice anti-spoof + NSA Hearsay submission |

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
