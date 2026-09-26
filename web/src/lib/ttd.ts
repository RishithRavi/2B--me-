// Time-to-detection stopwatch + takeover intervals. Pure functions over LiveState pieces.
// Markers are ground truth only (they never reach the scorer); detection = first trust tick < 0.40.
import { TRUST_CONFIG, type BlockScored, type MarkerPoint, type Modality, type TrustPoint } from "./contracts";

export const DETECT_THRESHOLD = TRUST_CONFIG.arming.threshold; // 0.40

export type TtdStatus = "idle" | "running" | "detected" | "ended";

export interface TtdResult {
  status: TtdStatus;
  /** takeover_start (ms epoch) */
  start: number | null;
  /** detection tick time, or takeover_end when not detected (ms epoch) */
  stop: number | null;
  /** detected: frozen TTD; running: elapsed so far; ended: elapsed until takeover_end */
  seconds: number | null;
  /** block_scored events per modality inside [start, stop|now] */
  counts: Partial<Record<Modality, number>>;
  /** confidence at detection (if detected) */
  confidence: number | null;
}

const ms = (iso: string) => Date.parse(iso);

export function latestTakeoverStart(markers: MarkerPoint[]): MarkerPoint | null {
  let best: MarkerPoint | null = null;
  for (const m of markers) {
    if (m.label !== "takeover_start") continue;
    if (!best || ms(m.t) > ms(best.t)) best = m;
  }
  return best;
}

function countBlocks(blocks: BlockScored[], from: number, to: number): Partial<Record<Modality, number>> {
  const counts: Partial<Record<Modality, number>> = {};
  for (const b of blocks) {
    const t = ms(b.t_end);
    if (t > from && t <= to) counts[b.modality] = (counts[b.modality] ?? 0) + 1;
  }
  return counts;
}

export function computeTtd(
  markers: MarkerPoint[],
  history: TrustPoint[],
  blocks: BlockScored[],
  now: number = Date.now(),
): TtdResult {
  const startMarker = latestTakeoverStart(markers);
  if (!startMarker) return { status: "idle", start: null, stop: null, seconds: null, counts: {}, confidence: null };
  const start = ms(startMarker.t);

  const detection = history
    .filter((p) => ms(p.t) > start && p.confidence < DETECT_THRESHOLD)
    .sort((a, b) => ms(a.t) - ms(b.t))[0];
  if (detection) {
    const stop = ms(detection.t);
    return {
      status: "detected",
      start,
      stop,
      seconds: (stop - start) / 1000,
      counts: countBlocks(blocks, start, stop),
      confidence: detection.confidence,
    };
  }

  const end = markers
    .filter((m) => m.label === "takeover_end" && ms(m.t) > start)
    .sort((a, b) => ms(a.t) - ms(b.t))[0];
  if (end) {
    const stop = ms(end.t);
    return { status: "ended", start, stop, seconds: (stop - start) / 1000, counts: countBlocks(blocks, start, stop), confidence: null };
  }
  return {
    status: "running",
    start,
    stop: null,
    seconds: Math.max(0, (now - start) / 1000),
    counts: countBlocks(blocks, start, now),
    confidence: null,
  };
}

export interface Interval {
  from: number;
  to: number;
  open: boolean;
}

/** Pair every takeover_start with the next takeover_end (or `now` while still open). */
export function takeoverIntervals(markers: MarkerPoint[], now: number = Date.now()): Interval[] {
  const sorted = [...markers].sort((a, b) => ms(a.t) - ms(b.t));
  const out: Interval[] = [];
  let open: number | null = null;
  for (const m of sorted) {
    if (m.label === "takeover_start" && open === null) open = ms(m.t);
    else if ((m.label === "takeover_end" || m.label === "reset") && open !== null) {
      out.push({ from: open, to: ms(m.t), open: false });
      open = null;
    }
  }
  if (open !== null) out.push({ from: open, to: now, open: true });
  return out;
}

/** True while the latest takeover_start has no later takeover_end/reset. */
export function takeoverOpen(markers: MarkerPoint[]): boolean {
  const iv = takeoverIntervals(markers, Date.now());
  return iv.length > 0 && iv[iv.length - 1].open;
}
