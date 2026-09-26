# Day-1 smoke tests (§11.1) — pass/fail, fill in as you go

| Check | How | Result | Who / when |
|---|---|---|---|
| Tiger extensions | `SELECT extname, extversion FROM pg_extension` → timescaledb ≥ 2.20; vector + vectorscale installable; toolkit | | |
| Tiger DDL | `uv run python -m app.db.migrate` (server/) runs twice cleanly | local TimescaleDB 2.30.1: PASS (Claude 01:50) | |
| Tiger jobs | `/api/tiger/stats` → columnstore jobs at 15 min for feature_blocks + trust_ticks | local: PASS (jobs 1009/1010 @ 00:15:00) | |
| Agent | `twobme-agent doctor` | | |
| Voice models | DF_Arena + ECAPA load on batch box + VM; ms/window recorded | | |
| ElevenLabs | `GET /v1/models` has `eleven_flash_v2_5` + `scribe_v2`; IVC on plan; `pcm_16000` allowed | | |
| ElevenLabs quota | `GET /v1/user/subscription` shown in `/status` (amber at 80%) | | |
| Vultr inference | `GET /v1/models`; pin `VULTR_INFERENCE_MODEL` | | |
| DNS | `dig +short 2bme.tech www.2bme.tech app.2bme.tech api.2bme.tech` → VM IP | | |
| TLS | Caddy cert issued (staging CA first, then prod) | | |
| Mic | getUserMedia works on https://2bme.tech/mictest; Chrome site setting Microphone = Allow; macOS mic enabled for Chrome | | |
| Hearsay | `hearsay_submission/RULES.md` answered | | |
