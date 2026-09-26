// SAMPLE data for mock mode only (?mock=1 / NEXT_PUBLIC_MOCK=1). Pages show a "sample" badge whenever it's used.
// The report samples mirror contracts/fixtures/reports/*.json ("SAMPLE FIXTURE — not real results").
import type {
  AnomalyRow,
  BaselineOut,
  EvalReport,
  HearsayReport,
  Modality,
  RedteamReport,
  SessionRow,
  TigerStats,
  TrustSeries,
} from "./contracts";
import { FEATURE_SPEC } from "./contracts";

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
// Deterministic pseudo-random so the sample doesn't jump between renders.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export function sampleSessions(now = Date.now()): SessionRow[] {
  const base = Math.floor(now / MIN) * MIN;
  const rows: [number, number, number | null, number, number | null, number, number][] = [
    // startMinAgo, durMin, avg, n_ticks, min, anomalies, markers
    [18, 18, 0.71, 216, 0.004, 2, 3],
    [55, 31, 0.96, 372, 0.9, 0, 1],
    [140, 46, 0.95, 552, 0.83, 0, 0],
    [310, 62, 0.94, 744, 0.61, 1, 2],
    [1440, 95, 0.97, 1140, 0.88, 0, 0],
  ];
  return rows.map(([ago, dur, avg, n, min, an, mk], i) => ({
    session_id: `sample-session-${i + 1}`,
    device_id: "mock-device-a",
    user_id: "sample-user-a",
    channel: "desktop",
    status: i === 0 ? "active" : "closed",
    started_at: iso(base - ago * MIN),
    ended_at: i === 0 ? null : iso(base - (ago - dur) * MIN),
    n_ticks: n,
    avg_confidence: avg,
    min_confidence: min,
    n_anomalies: an,
    n_markers: mk,
  }));
}

export function sampleTrust(sessionId: string, now = Date.now()): TrustSeries {
  const s = sampleSessions(now).find((x) => x.session_id === sessionId) ?? sampleSessions(now)[0];
  const start = Date.parse(s.started_at);
  const end = s.ended_at ? Date.parse(s.ended_at) : now;
  const r = rng(start / 1000);
  const takeover = s.n_anomalies > 0 ? start + (end - start) * 0.55 : null;
  const points = [];
  let c = 0.97;
  for (let t = start; t <= end; t += MIN) {
    if (takeover && t >= takeover && t < takeover + 4 * MIN) c = Math.max(0.05, c - 0.2);
    else if (takeover && t >= takeover + 4 * MIN && t < takeover + 6 * MIN) c = 0.97;
    else c = Math.min(0.99, Math.max(0.85, c + (r() - 0.5) * 0.03));
    const spread = 0.01 + r() * 0.03;
    points.push({ t: iso(t), avg: c, min: Math.max(0, c - spread * 2), max: Math.min(1, c + spread), last: c, n_stepups: takeover && Math.abs(t - takeover - 3 * MIN) < MIN / 2 ? 1 : 0 });
  }
  return {
    session_id: s.session_id,
    bucket: "1 minute",
    points,
    markers: takeover
      ? [
          { t: iso(takeover), label: "takeover_start", text: null },
          { t: iso(takeover + 5 * MIN), label: "takeover_end", text: null },
        ]
      : [],
  };
}

export function sampleAnomalies(now = Date.now()): AnomalyRow[] {
  return [
    {
      id: "sample-an-1",
      time: iso(now - 7 * MIN),
      kind: "voice_spoof",
      severity: 5,
      device_id: "mock-device-a",
      session_id: "sample-session-1",
      trust_before: 0.21,
      trust_after: 0.005,
      top_features: [],
      action: "lock",
      challenge_id: "sample-ch-1",
      challenge_decision: "BLOCK_SPOOF",
      explanation: "The response voice matched the owner's speaker embedding (0.58) but carried vocoder artifacts: missing energy above 7 kHz and unnaturally low pitch jitter. It was classed as synthetic (0.93). (sample)",
      resolution: "locked",
    },
    {
      id: "sample-an-2",
      time: iso(now - 8 * MIN),
      kind: "takeover_suspected",
      severity: 4,
      device_id: "mock-device-a",
      session_id: "sample-session-1",
      trust_before: 0.97,
      trust_after: 0.33,
      top_features: [
        { feature: "kb.dd_p50", label: "flight time", unit: "ms", z: 3.1 },
        { feature: "ms.curv_p50", label: "path curvature", unit: "rad/dd", z: 2.8 },
        { feature: "kb.hold_p50", label: "key hold", unit: "ms", z: -2.4 },
      ],
      action: "challenge_armed",
      challenge_id: "sample-ch-1",
      challenge_decision: "BLOCK_SPOOF",
      explanation: "Typing rhythm shifted sharply. Flight time between keys ran about 3σ slower than baseline, and pointer paths curved more than usual. (sample)",
      resolution: "blocked",
    },
    {
      id: "sample-an-3",
      time: iso(now - 4.2 * 60 * MIN),
      kind: "trust_drop",
      severity: 2,
      device_id: "mock-device-a",
      session_id: "sample-session-4",
      trust_before: 0.93,
      trust_after: 0.61,
      top_features: [{ feature: "wf.switch_latency_p50", label: "task-switch latency", unit: "ms", z: 2.2 }],
      action: null,
      challenge_id: null,
      challenge_decision: null,
      explanation: null,
      resolution: "recovered",
    },
  ];
}

export function sampleBaseline(modality: Modality, sessionId: string | null): BaselineOut {
  const r = rng(modality.length * 97 + (sessionId?.length ?? 0));
  const impostor = sessionId === "sample-session-1";
  return {
    modality,
    session_id: sessionId,
    rows: FEATURE_SPEC.modalities[modality].features
      .filter((f) => f.name !== "wf.markov_ll")
      .map((f) => {
        const mean = f.unit === "ms" ? 80 + r() * 300 : f.unit === "frac" ? r() * 0.5 : 0.5 + r() * 5;
        const std = mean * (0.12 + r() * 0.1);
        const z = (impostor ? 1.2 : 0) + (r() - 0.5) * (impostor ? 3.5 : 1.6);
        return {
          feature: f.name,
          column: f.column,
          label: f.label,
          unit: f.unit,
          session_median: mean + z * std,
          baseline_mean: mean,
          baseline_std: std,
          z,
        };
      }),
  };
}

export function sampleTiger(): TigerStats {
  return {
    ok: true,
    hypertables: [
      { name: "feature_blocks", total_chunks: 26, compressed_chunks: 22, before_bytes: 412_000_000, after_bytes: 41_800_000, ratio: 9.9, rows_estimate: 1_240_000 },
      { name: "trust_ticks", total_chunks: 26, compressed_chunks: 22, before_bytes: 96_000_000, after_bytes: 8_100_000, ratio: 11.9, rows_estimate: 610_000 },
      { name: "anomalies", total_chunks: 4, compressed_chunks: 2, before_bytes: 1_900_000, after_bytes: 420_000, ratio: 4.5, rows_estimate: 212 },
      { name: "voice_attempts", total_chunks: 3, compressed_chunks: 1, before_bytes: 800_000, after_bytes: 210_000, ratio: 3.8, rows_estimate: 96 },
    ],
    jobs: [
      { job_id: 1001, proc: "policy_columnstore", hypertable: "feature_blocks", schedule_interval: "12:00:00", last_run_status: "Success", next_start: iso(Date.now() + 3 * 60 * MIN) },
      { job_id: 1002, proc: "policy_columnstore", hypertable: "trust_ticks", schedule_interval: "12:00:00", last_run_status: "Success", next_start: iso(Date.now() + 3 * 60 * MIN) },
      { job_id: 1003, proc: "policy_refresh_continuous_aggregate", hypertable: "trust_1m", schedule_interval: "00:01:00", last_run_status: "Success", next_start: iso(Date.now() + 40_000) },
      { job_id: 1004, proc: "policy_retention", hypertable: "presence", schedule_interval: "1 day", last_run_status: "Success", next_start: iso(Date.now() + 20 * 60 * MIN) },
    ],
    caggs: ["trust_1m", "blocks_5m"],
    extensions: { timescaledb: "2.22.1", vector: "0.8.1" },
    cached_at: null,
  };
}

export function sampleEval(): EvalReport {
  // Concave curve tpr = fpr^a that passes exactly through the EER point (eer, 1 − eer).
  const roc = (eer: number): [number, number][] => {
    const a = Math.log(1 - eer) / Math.log(eer);
    return Array.from({ length: 21 }, (_, i) => {
      const fpr = i / 20;
      return [fpr, Math.pow(fpr, a)] as [number, number];
    });
  };
  const m = (auc: number, eer: number, weak = false) => ({ auc, eer, roc: roc(eer), n_genuine: 120, n_impostor: 60, beta: 6, weak });
  return {
    generated_at: "2026-09-26T18:40:00.000Z",
    n_blocks: { a: { keyboard: 400, mouse: 400, scroll: 400, workflow: 400, temporal: 400 }, b: { keyboard: 60, mouse: 60, scroll: 60, workflow: 60, temporal: 60 } },
    modalities: { keyboard: m(0.91, 0.16), mouse: m(0.84, 0.23), scroll: m(0.71, 0.34), workflow: m(0.64, 0.39, true), temporal: m(0.69, 0.36) },
    fused: { auc: 0.96, eer: 0.09 },
    ablation: [
      { removed: "keyboard", fused_eer: 0.14 },
      { removed: "mouse", fused_eer: 0.12 },
      { removed: "scroll", fused_eer: 0.1 },
      { removed: "workflow", fused_eer: 0.09 },
      { removed: "temporal", fused_eer: 0.095 },
    ],
    identification: { labels: ["a", "b"], confusion: [[112, 8], [9, 51]], accuracy: 0.906 },
    live_trials: [
      { t_start: "2026-09-26T14:10:00.000Z", ttd_s: 38, detected: true },
      { t_start: "2026-09-26T14:15:00.000Z", ttd_s: 52, detected: true },
      { t_start: "2026-09-26T14:20:00.000Z", ttd_s: 41, detected: true },
      { t_start: "2026-09-26T14:25:00.000Z", ttd_s: 60, detected: true },
      { t_start: "2026-09-26T14:30:00.000Z", ttd_s: 47, detected: true },
    ],
    splice: null,
    notes: ["SAMPLE FIXTURE — not real results", "Impostor data from teammates only."],
  };
}

export function sampleRedteam(): RedteamReport {
  return {
    generated_at: "2026-09-26T18:40:00.000Z",
    delivery: "acoustic",
    thresholds: { T_ASV_HIGH: 0.6, T_ASV_LOW: 0.35, T_CM: 0.5, T_SPEC: 0.8 },
    genuine: { n: 20, frr: 0.05, far: null },
    impostor: { n: 20, frr: null, far: 0.0 },
    attacks: [
      { class: "tts_flash", generator: "eleven_flash_v2_5", n: 20, far_asv_only: 0.55, far_cm_only: 0.05, far_fused: 0.0, mean_asv_cos: 0.58 },
      { class: "replay", generator: "phone_speaker", n: 20, far_asv_only: 0.8, far_cm_only: 0.4, far_fused: 0.0, mean_asv_cos: 0.66 },
    ],
  };
}

export function sampleHearsay(): HearsayReport {
  return {
    generated_at: "2026-09-26T18:40:00.000Z",
    rules_confirmed: false,
    dev: { n: 800, min_dcf_a: 0.21, min_dcf_b: 0.18, eer: 0.07 },
    detectors: [{ name: "df_arena_500m", min_dcf_a: 0.24, min_dcf_b: 0.2 }],
    fusion: { method: "mean_rank", members: ["df_arena_500m"] },
    ablation: [],
  };
}
