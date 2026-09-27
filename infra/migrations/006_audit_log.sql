-- 006 (additive, Sat 18:00): org audit trail for the admin panel (§2.4) + the org-demo team field.
-- Idempotent. Only the CREATE TABLE ... WITH (tsdb.hypertable, ...) form (as in 003).

-- org-demo employees carry a team ("Finance", "Engineering", ...); null for real users
ALTER TABLE users ADD COLUMN IF NOT EXISTS team text;

-- Rows mirror twobme_common.types.AuditRow: trust-level changes, alerts, challenges, decisions, locks,
-- markers, model versions and admin actions. Written by the batch writer; the API keeps an in-memory
-- ring as the degraded-mode fallback.
CREATE TABLE IF NOT EXISTS audit_log (
  time        timestamptz NOT NULL,
  id          uuid NOT NULL,
  kind        text NOT NULL,    -- trust_change | alert | challenge | decision | lock | admin_action | marker | model
  device_id   uuid,
  user_id     uuid,
  handle      text,             -- the subject's pseudonymous handle ("Employee 07")
  actor       text NOT NULL,    -- "system" or the acting admin's handle
  summary     text NOT NULL,
  severity    smallint NOT NULL DEFAULT 0,
  ref_id      uuid,             -- anomaly / challenge / decision id
  PRIMARY KEY (id, time)        -- a unique index must include the partition column
) WITH (
  tsdb.hypertable,
  tsdb.partition_column = 'time',
  tsdb.chunk_interval = '1 day',
  tsdb.segmentby = 'device_id',
  tsdb.orderby = 'time DESC'
);
CREATE INDEX IF NOT EXISTS audit_log_device_time ON audit_log (device_id, time DESC);
