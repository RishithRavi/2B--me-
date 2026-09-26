-- 004: continuous aggregates (§5.5). Idempotent. Plain aggregates only (no toolkit needed).

CREATE MATERIALIZED VIEW IF NOT EXISTS trust_1m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 minute', time) AS bucket,
  device_id,
  avg(confidence)                               AS avg_conf,
  min(confidence)                               AS min_conf,
  max(confidence)                               AS max_conf,
  last(confidence, time)                        AS last_conf,
  count(*) FILTER (WHERE challenge_issued)      AS n_stepups,
  count(*)                                      AS n_ticks
FROM trust_ticks
GROUP BY bucket, device_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('trust_1m',
  start_offset => INTERVAL '3 hours', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute', if_not_exists => true);

CREATE MATERIALIZED VIEW IF NOT EXISTS block_baseline_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 hour', time) AS bucket,
  user_id,
  modality,
  count(*) AS n,
  avg(kb_hold_p50) AS kb_hold_p50_avg,                 stddev(kb_hold_p50) AS kb_hold_p50_std,                 count(kb_hold_p50) AS kb_hold_p50_n,
  avg(kb_dd_p50) AS kb_dd_p50_avg,                     stddev(kb_dd_p50) AS kb_dd_p50_std,                     count(kb_dd_p50) AS kb_dd_p50_n,
  avg(kb_ud_p50) AS kb_ud_p50_avg,                     stddev(kb_ud_p50) AS kb_ud_p50_std,                     count(kb_ud_p50) AS kb_ud_p50_n,
  avg(kb_speed_kps) AS kb_speed_kps_avg,               stddev(kb_speed_kps) AS kb_speed_kps_std,               count(kb_speed_kps) AS kb_speed_kps_n,
  avg(kb_bksp_rate) AS kb_bksp_rate_avg,               stddev(kb_bksp_rate) AS kb_bksp_rate_std,               count(kb_bksp_rate) AS kb_bksp_rate_n,
  avg(ms_v_p50) AS ms_v_p50_avg,                       stddev(ms_v_p50) AS ms_v_p50_std,                       count(ms_v_p50) AS ms_v_p50_n,
  avg(ms_curv_p50) AS ms_curv_p50_avg,                 stddev(ms_curv_p50) AS ms_curv_p50_std,                 count(ms_curv_p50) AS ms_curv_p50_n,
  avg(ms_straightness_p50) AS ms_straightness_p50_avg, stddev(ms_straightness_p50) AS ms_straightness_p50_std, count(ms_straightness_p50) AS ms_straightness_p50_n,
  avg(ms_click_hold_p50) AS ms_click_hold_p50_avg,     stddev(ms_click_hold_p50) AS ms_click_hold_p50_std,     count(ms_click_hold_p50) AS ms_click_hold_p50_n,
  avg(sc_v_mean_p50) AS sc_v_mean_p50_avg,             stddev(sc_v_mean_p50) AS sc_v_mean_p50_std,             count(sc_v_mean_p50) AS sc_v_mean_p50_n,
  avg(wf_switch_rate) AS wf_switch_rate_avg,           stddev(wf_switch_rate) AS wf_switch_rate_std,           count(wf_switch_rate) AS wf_switch_rate_n,
  avg(tp_rate) AS tp_rate_avg,                         stddev(tp_rate) AS tp_rate_std,                         count(tp_rate) AS tp_rate_n,
  avg(tp_b) AS tp_b_avg,                               stddev(tp_b) AS tp_b_std,                               count(tp_b) AS tp_b_n,
  avg(tp_idle_frac) AS tp_idle_frac_avg,               stddev(tp_idle_frac) AS tp_idle_frac_std,               count(tp_idle_frac) AS tp_idle_frac_n,
  avg(tp_peak_hz) AS tp_peak_hz_avg,                   stddev(tp_peak_hz) AS tp_peak_hz_std,                   count(tp_peak_hz) AS tp_peak_hz_n
FROM feature_blocks
WHERE baseline_eligible
GROUP BY bucket, user_id, modality
WITH NO DATA;

SELECT add_continuous_aggregate_policy('block_baseline_hourly',
  start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '15 minutes', if_not_exists => true);

CREATE MATERIALIZED VIEW IF NOT EXISTS anomaly_daily
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 day', time) AS bucket,
  user_id,
  kind,
  count(*)       AS n,
  max(severity)  AS max_severity
FROM anomalies
GROUP BY bucket, user_id, kind
WITH NO DATA;

SELECT add_continuous_aggregate_policy('anomaly_daily',
  start_offset => INTERVAL '30 days', end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour', if_not_exists => true);
