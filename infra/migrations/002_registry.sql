-- 002: plain tables (§5.5). Idempotent.

CREATE TABLE IF NOT EXISTS users (
  id                   uuid PRIMARY KEY,
  email                text NOT NULL UNIQUE,
  pw_hash              text NOT NULL,
  handle               text NOT NULL,
  role                 text NOT NULL DEFAULT 'user',
  tz                   text NOT NULL DEFAULT 'America/New_York',
  totp_secret_enc      text,
  enrollment_status    text NOT NULL DEFAULT 'new',
  sessions_revoked_at  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  token_hash   text NOT NULL UNIQUE,
  label        text NOT NULL DEFAULT 'MacBook',
  os           text,
  pointer      text,
  display      jsonb,
  last_seen    timestamptz,
  mode         text NOT NULL DEFAULT 'enroll',
  locked       boolean NOT NULL DEFAULT false,
  locked_at    timestamptz,
  lock_reason  text,
  trust_state  jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL,
  device_id     uuid,
  channel       text NOT NULL DEFAULT 'desktop',   -- desktop | web
  kind          text NOT NULL DEFAULT 'normal',    -- normal | sandbox | ephemeral
  status        text NOT NULL DEFAULT 'active',    -- active | ended | purged
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  ended_reason  text,                              -- screen_locked | ws_timeout | demo_reset | purged
  run_id        uuid
);
CREATE INDEX IF NOT EXISTS sessions_device_started ON sessions (device_id, started_at DESC);

CREATE TABLE IF NOT EXISTS models (
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL,
  channel           text NOT NULL DEFAULT 'desktop',
  version           integer NOT NULL,
  schema_version    smallint NOT NULL,
  trained_at        timestamptz NOT NULL,
  n_blocks          jsonb,
  metrics           jsonb,
  headline_medians  jsonb,
  artifact_path     text,
  is_active         boolean NOT NULL DEFAULT false,
  parent_version    integer,
  UNIQUE (user_id, channel, version)
);

CREATE TABLE IF NOT EXISTS voice_profiles (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL,
  label              text NOT NULL DEFAULT 'quiet',   -- quiet | expo
  speaker_embedding  vector(192),
  utt_embeddings     jsonb,
  spectral_summary   vector(64),                      -- 64-bin mel LTAS (dB)
  n_utts             integer NOT NULL,
  intra_cos          real,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_profiles_user ON voice_profiles (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS voice_challenges (
  id                   uuid PRIMARY KEY,
  user_id              uuid NOT NULL,                 -- subject
  device_id            uuid,
  session_id           uuid,
  trigger              text NOT NULL,                 -- proactive | step_up | unlock | redteam | sandbox
  status               text NOT NULL,
  attempt              integer NOT NULL DEFAULT 1,
  phrase               text NOT NULL,
  issued_at            timestamptz NOT NULL,
  prompt_first_get_at  timestamptz,
  expires_at           timestamptz,
  asv_cos              real,
  cm_p_spoof           real,
  spec_sim             real,
  phrase_wer           real,
  onset_ms             integer,
  voice_confidence     real,
  decision             text,
  findings             jsonb,
  decision_id          uuid,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_challenges_device ON voice_challenges (device_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS decisions (
  id                  uuid PRIMARY KEY,
  time                timestamptz NOT NULL,
  user_id             uuid NOT NULL,
  device_id           uuid,
  session_id          uuid,
  web_session_id      text,
  action              text NOT NULL,
  amount_cents        integer,
  tier                text NOT NULL,
  binding             text NOT NULL,
  confidence          real NOT NULL,
  decision            text NOT NULL,
  trans_status        text NOT NULL,
  status              text NOT NULL,
  challenge_id        uuid,
  final_decision      text,
  final_trans_status  text,
  resolved_at         timestamptz,
  reasons             jsonb,
  label               text,
  actor               text
);
CREATE INDEX IF NOT EXISTS decisions_user_time ON decisions (user_id, time DESC);
