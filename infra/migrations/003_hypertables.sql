-- 003: hypertables (§5.5). Only the CREATE TABLE ... WITH (tsdb.hypertable, ...) form; never the
-- legacy create_hypertable(). Idempotent.

CREATE TABLE IF NOT EXISTS feature_blocks (
  time                 timestamptz NOT NULL,          -- block end
  block_start          timestamptz NOT NULL,
  user_id              uuid NOT NULL,
  device_id            uuid NOT NULL,
  session_id           uuid NOT NULL,
  channel              text NOT NULL DEFAULT 'desktop',
  modality             text NOT NULL,
  schema_version       smallint NOT NULL,
  mode                 text NOT NULL,
  n                    integer NOT NULL,
  features             real[] NOT NULL,               -- twobme_common.spec.vectorize() order
  kb_hold_p50          real,
  kb_dd_p50            real,
  kb_ud_p50            real,
  kb_speed_kps         real,
  kb_bksp_rate         real,
  ms_v_p50             real,
  ms_curv_p50          real,
  ms_straightness_p50  real,
  ms_click_hold_p50    real,
  sc_v_mean_p50        real,
  wf_switch_rate       real,
  tp_rate              real,
  tp_b                 real,
  tp_idle_frac         real,
  tp_peak_hz           real,
  extras               jsonb,                         -- transitions / psd
  typicality           real,
  llr                  real,
  q                    real,
  delta                real,
  model_version        integer,
  label                text NOT NULL,
  actor                text NOT NULL,
  baseline_eligible    boolean NOT NULL,              -- mode = enroll AND label IS DISTINCT FROM 'impostor'
  update_candidate     boolean NOT NULL DEFAULT false,
  flags                jsonb,
  UNIQUE (session_id, modality, time)
) WITH (
  tsdb.hypertable,
  tsdb.partition_column = 'time',
  tsdb.chunk_interval = '1 hour',
  tsdb.segmentby = 'device_id',
  tsdb.orderby = 'time DESC'
);
CREATE INDEX IF NOT EXISTS feature_blocks_user_mod ON feature_blocks (user_id, modality, time DESC);

CREATE TABLE IF NOT EXISTS trust_ticks (
  time              timestamptz NOT NULL,
  device_id         uuid NOT NULL,
  session_id        uuid,
  user_id           uuid NOT NULL,
  run_id            uuid,
  seq               integer,
  confidence        real NOT NULL,
  display           smallint NOT NULL,
  logit             real NOT NULL,
  delta_logit       real NOT NULL,
  level             text NOT NULL,
  kb_llr            real,
  ms_llr            real,
  sc_llr            real,
  wf_llr            real,
  tp_llr            real,
  challenge_issued  boolean NOT NULL DEFAULT false,
  model_version     integer,
  label             text,
  actor             text,
  flags             jsonb,
  UNIQUE (device_id, time)
) WITH (
  tsdb.hypertable,
  tsdb.partition_column = 'time',
  tsdb.chunk_interval = '1 hour',
  tsdb.segmentby = 'device_id',
  tsdb.orderby = 'time DESC'
);

CREATE TABLE IF NOT EXISTS anomalies (
  time          timestamptz NOT NULL,
  id            uuid NOT NULL,
  user_id       uuid,
  device_id     uuid,
  session_id    uuid,
  kind          text NOT NULL,   -- trust_drop | takeover_suspected | voice_spoof | voice_impostor | lock | redteam_tool
  severity      smallint NOT NULL,
  trust_before  real,
  trust_after   real,
  top_features  jsonb,
  action        text,
  challenge_id  uuid,
  explanation   text,
  resolution    text,
  PRIMARY KEY (id, time)         -- a unique index must include the partition column
) WITH (
  tsdb.hypertable,
  tsdb.partition_column = 'time',
  tsdb.chunk_interval = '1 day'
);

CREATE TABLE IF NOT EXISTS markers (
  time        timestamptz NOT NULL,
  device_id   uuid NOT NULL,
  session_id  uuid,
  label       text NOT NULL,    -- takeover_start | takeover_end | note | rearm | reset
  text        text,
  UNIQUE (device_id, time, label)
) WITH (
  tsdb.hypertable,
  tsdb.partition_column = 'time',
  tsdb.chunk_interval = '1 day'
);

-- The auto-created columnstore policy runs daily; replace it so compression is visible during the event.
CALL remove_columnstore_policy('feature_blocks', if_exists => true);
CALL add_columnstore_policy('feature_blocks', after => INTERVAL '2 hours', schedule_interval => INTERVAL '15 minutes');
CALL remove_columnstore_policy('trust_ticks', if_exists => true);
CALL add_columnstore_policy('trust_ticks', after => INTERVAL '2 hours', schedule_interval => INTERVAL '15 minutes');
