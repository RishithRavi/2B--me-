-- 001: extensions + migration bookkeeping. Idempotent. Every statement runs in autocommit.
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS vector;
-- optional (P2 identity_centroids); failure is logged, not fatal
CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
