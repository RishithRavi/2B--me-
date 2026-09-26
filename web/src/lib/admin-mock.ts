// Synthetic, anonymized multi-employee roster for the admin/org panel (§2.4, IMPLEMENTATION.md, PROPOSED).
// Nothing here talks to the API or Tiger: it's client-side fabricated data standing in for an organization's
// worth of devices, exactly as newGoal.txt describes ("synthetic sessions of let's say 20 different employees
// whose information is first anonymized"). Real per-employee data would arrive the same shape as one device's
// LiveState (already Claude-owned, §6 A3) — this only needs to look like N of those side by side.
import type { BlockScored, DeviationOut, FeedItem, Level, Modality, ModalityContribution, TrustLive, TrustPoint } from "./contracts";
import { MODALITIES } from "./ui";

export interface SyntheticEmployee {
  id: string;
  pseudonym: string;
  team: string;
  device: { label: string; locked: boolean };
  trust: TrustLive;
  history: TrustPoint[];
  blocks: BlockScored[];
  feed: FeedItem[];
  lastAlertAt: string | null;
}

const TEAMS = ["Finance", "Engineering", "Sales", "Support", "Ops", "Legal"] as const;
const DEVICE_KINDS = ["MacBook Pro", "MacBook Air", "ThinkPad X1", "Dell XPS"] as const;

const FEATURES: Record<Modality, { feature: string; label: string; unit: string }[]> = {
  keyboard: [
    { feature: "kb_digraph_latency_p50", label: "digraph latency (median)", unit: "ms" },
    { feature: "kb_hold_p50", label: "key hold time (median)", unit: "ms" },
    { feature: "kb_correction_rate", label: "correction rate", unit: "/min" },
  ],
  mouse: [
    { feature: "mouse_curvature_p50", label: "movement curvature (median)", unit: "" },
    { feature: "mouse_velocity_p90", label: "peak velocity", unit: "px/s" },
    { feature: "mouse_click_latency_p50", label: "click latency (median)", unit: "ms" },
  ],
  scroll: [
    { feature: "scroll_burst_len_p50", label: "scroll burst length (median)", unit: "events" },
    { feature: "scroll_reversal_rate", label: "scroll reversal rate", unit: "/min" },
  ],
  workflow: [
    { feature: "app_switch_rate", label: "app-switch rate", unit: "/min" },
    { feature: "task_switch_latency_p50", label: "task-switch latency (median)", unit: "ms" },
  ],
  temporal: [
    { feature: "event_burstiness", label: "event burstiness", unit: "" },
    { feature: "idle_interval_p50", label: "idle interval (median)", unit: "s" },
  ],
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];
const iso = (ms: number) => new Date(ms).toISOString();
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function levelFor(confidence: number, locked: boolean): Level {
  if (locked) return "locked";
  if (confidence >= 0.8) return "normal";
  if (confidence >= 0.4) return "watch";
  return "suspicious";
}

function makeHistory(now: number, endConfidence: number, minutes = 10): TrustPoint[] {
  const points: TrustPoint[] = [];
  const steps = minutes * 6; // one point every 10s
  let c = clamp(endConfidence + rand(-0.05, 0.05), 0.05, 0.99);
  for (let i = steps; i >= 0; i--) {
    const t = now - i * 10_000;
    c = clamp(c + rand(-0.03, 0.03) + (endConfidence - c) * 0.08, 0.02, 0.99);
    points.push({ t: iso(t), confidence: c, level: levelFor(c, false) });
  }
  points[points.length - 1] = { t: iso(now), confidence: endConfidence, level: levelFor(endConfidence, false) };
  return points;
}

function makePerModality(against: boolean): Partial<Record<Modality, ModalityContribution>> {
  const out: Partial<Record<Modality, ModalityContribution>> = {};
  for (const m of MODALITIES) {
    const sign = against && Math.random() < 0.6 ? -1 : 1;
    const delta = sign * rand(0.01, against ? 0.35 : 0.18);
    out[m] = { typicality: rand(0.3, 0.95), llr: rand(-2, 2), q: rand(0.5, 1), w: rand(0.1, 1), delta, n_blocks: Math.floor(rand(2, 40)) };
  }
  return out;
}

function makeBlocks(now: number, against: boolean): BlockScored[] {
  return MODALITIES.map((m, i) => {
    const feats = FEATURES[m];
    const top: DeviationOut[] = feats.map((f) => ({
      feature: f.feature,
      label: f.label,
      unit: f.unit,
      z: (against ? 1 : -1) * rand(0.5, against ? 3.4 : 1.8) * (Math.random() < 0.5 ? -1 : 1),
    }));
    const delta = (against ? -1 : 1) * rand(0.02, against ? 0.3 : 0.15);
    return {
      modality: m,
      t_start: iso(now - (i + 1) * 5000 - 5000),
      t_end: iso(now - i * 5000),
      n: Math.floor(rand(3, 20)),
      typicality: rand(0.3, 0.95),
      llr: rand(-2, 2),
      q: rand(0.5, 1),
      delta,
      top,
    };
  });
}

function makeFeed(now: number, name: string, suspicious: boolean, locked: boolean): { feed: FeedItem[]; lastAlertAt: string | null } {
  const feed: FeedItem[] = [
    { t: iso(now - 9 * 60_000), type: "session", text: `${name} signed in`, severity: 0 },
    { t: iso(now - 6 * 60_000), type: "model", text: "Model refreshed from overnight baseline", severity: 0 },
  ];
  let lastAlertAt: string | null = null;
  if (suspicious || locked) {
    const at = iso(now - rand(30_000, 4 * 60_000));
    feed.push({ t: at, type: "anomaly", text: "Trust fell below the watch threshold", severity: 3 });
    lastAlertAt = at;
  }
  if (locked) {
    const at = iso(now - rand(5_000, 90_000));
    feed.push({ t: at, type: "block", text: "Voice check failed — device locked", severity: 4 });
    lastAlertAt = at;
  }
  feed.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return { feed, lastAlertAt };
}

function makeEmployee(index: number, now: number): SyntheticEmployee {
  const id = `emp-${String(index + 1).padStart(2, "0")}`;
  const pseudonym = `Employee ${String(index + 1).padStart(2, "0")}`;
  const team = pick(TEAMS);
  const roll = Math.random();
  const locked = roll < 0.06;
  const suspicious = !locked && roll < 0.18;
  const confidence = locked ? rand(0.02, 0.15) : suspicious ? rand(0.2, 0.45) : rand(0.75, 0.99);
  const against = suspicious || locked;
  const now_t = now / 1000;

  const trust: TrustLive = {
    t: now_t,
    logit: Math.log(confidence / (1 - confidence)),
    delta_logit: against ? -rand(0.1, 0.6) : rand(0.02, 0.2),
    confidence,
    display: Math.round(confidence * 100),
    level: levelFor(confidence, locked),
    per_modality: makePerModality(against),
    reasons: against ? ["behavior_drift"] : [],
    seq: index,
    locked,
  };

  const { feed, lastAlertAt } = makeFeed(now, pseudonym, suspicious, locked);

  return {
    id,
    pseudonym,
    team,
    device: { label: `${pseudonym.replace("Employee ", "")}'s ${pick(DEVICE_KINDS)}`, locked },
    trust,
    history: makeHistory(now, confidence),
    blocks: makeBlocks(now, against),
    feed,
    lastAlertAt,
  };
}

export function generateRoster(n = 20): SyntheticEmployee[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => makeEmployee(i, now));
}
