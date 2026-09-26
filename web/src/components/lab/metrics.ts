// Pure helpers for /lab: operating points read off a report's ROC, and the report's own provenance notes.
// Everything here is derived from reports/eval.json as served; nothing is invented when a field is missing.
import type { EvalReport, Modality } from "@/lib/contracts";
import { MODALITIES } from "@/lib/ui";

/** [fpr, tpr] as written by twobme_ml.evaluation.roc_metrics (sklearn order: thresholds descending). */
export type RocPoint = readonly [number, number];

/** The trust threshold below which a proactive challenge is armed (§5.4); the /lab FAR/FRR panel is titled after it. */
export const ALERT_THRESHOLD = 0.4;
/** §0.1 #7: TTD over at least this many live takeover trials. */
export const LIVE_TRIALS_TARGET = 5;

function sorted(roc: readonly RocPoint[]): RocPoint[] {
  return [...roc]
    .filter(([f, t]) => Number.isFinite(f) && Number.isFinite(t))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * Equal-error operating point: where FAR (= fpr) meets FRR (= 1 − tpr), linearly interpolated between the two ROC
 * points that bracket the crossing (the same rule the evaluator uses for `eer`).
 */
export function eerPoint(roc: readonly RocPoint[]): { far: number; frr: number } | null {
  const pts = sorted(roc);
  if (pts.length < 2) return null;
  const diff = pts.map(([f, t]) => f - (1 - t));
  const i = diff.findIndex((d) => d >= 0);
  if (i === -1) {
    const [f, t] = pts[pts.length - 1];
    return { far: f, frr: 1 - t };
  }
  if (i === 0) {
    const [f, t] = pts[0];
    const v = (f + 1 - t) / 2;
    return { far: v, frr: v };
  }
  const [f0] = pts[i - 1];
  const [f1] = pts[i];
  const d0 = diff[i - 1];
  const d1 = diff[i];
  const w = d1 === d0 ? 0 : -d0 / (d1 - d0);
  const far = f0 + w * (f1 - f0);
  return { far, frr: far };
}

/** Best (lowest) FRR achievable while FAR stays at or below `maxFar`; the ROC step function, no interpolation. */
export function frrAtFar(roc: readonly RocPoint[], maxFar: number): number | null {
  const pts = sorted(roc);
  if (!pts.length) return null;
  let best: number | null = null;
  for (const [f, t] of pts) {
    if (f <= maxFar + 1e-12) best = best === null ? t : Math.max(best, t);
  }
  return best === null ? null : 1 - best;
}

export interface OperatingRow {
  m: Modality | "fused";
  /** FAR = FRR at the equal-error point */
  eer: number | null;
  /** FRR when FAR is held at or below the chosen budget (null when the report has no curve for this row) */
  frrAtBudget: number | null;
}

/** Per-branch operating points from each ROC, plus the fused EER (the report carries no fused curve). */
export function operatingRows(report: EvalReport, farBudget: number): OperatingRow[] {
  const rows: OperatingRow[] = [];
  for (const m of MODALITIES) {
    const r = report.modalities[m];
    if (!r || r.auc === null || !r.roc?.length) continue;
    rows.push({ m, eer: eerPoint(r.roc)?.far ?? r.eer, frrAtBudget: frrAtFar(r.roc, farBudget) });
  }
  if (report.fused.eer !== null) rows.push({ m: "fused", eer: report.fused.eer, frrAtBudget: null });
  return rows;
}

/**
 * "Disabled A modalities: {'keyboard': 'Need 100 eligible blocks; have 39', …}" (a Python dict repr written by
 * twobme_ml.evaluation) → { keyboard: "Need 100 eligible blocks; have 39", … }.
 */
export function disabledReasons(notes: readonly string[], who: "A" | "B" = "A"): Partial<Record<Modality, string>> {
  const out: Partial<Record<Modality, string>> = {};
  const note = notes.find((n) => n.startsWith(`Disabled ${who} modalities:`));
  if (!note) return out;
  for (const match of note.matchAll(/['"](\w+)['"]\s*:\s*['"]([^'"]*)['"]/g)) {
    const m = match[1] as Modality;
    if ((MODALITIES as readonly string[]).includes(m)) out[m] = match[2];
  }
  return out;
}

export type DataKind = "sample" | "synthetic" | "real" | "unknown";

/** What the report says about its own data, from its notes (the evaluator writes these; we only read them). */
export function dataKind(report: EvalReport): DataKind {
  const up = report.notes.map((n) => n.toUpperCase());
  if (up.some((n) => n.includes("SAMPLE"))) return "sample";
  if (up.some((n) => n.includes("SYNTHETIC DATA ONLY"))) return "synthetic";
  if (up.some((n) => n.includes("REAL RECORDINGS"))) return "real";
  return "unknown";
}

/** Held-out block totals per person (n_blocks is {a: {modality: n}, b: {…}}). */
export function blockTotals(report: EvalReport): { a: number; b: number } {
  const sum = (who: string) => Object.values(report.n_blocks[who] ?? {}).reduce((s, v) => s + (v ?? 0), 0);
  return { a: sum("a"), b: sum("b") };
}

export function measuredModalities(report: EvalReport): Modality[] {
  return MODALITIES.filter((m) => {
    const r = report.modalities[m];
    return !!r && r.auc !== null;
  });
}

/** Identification is shown only when it was actually run (non-empty confusion and an accuracy). */
export function identificationRan(report: EvalReport): boolean {
  const id = report.identification;
  if (!id || id.accuracy === null) return false;
  return id.confusion.flat().reduce((s, v) => s + v, 0) > 0;
}

export function liveTrialStats(report: EvalReport): { n: number; detected: number; median: number | null } {
  const trials = report.live_trials ?? [];
  const ttd = trials.filter((t) => t.detected && t.ttd_s !== null).map((t) => t.ttd_s as number);
  const s = [...ttd].sort((a, b) => a - b);
  const median = s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
  return { n: trials.length, detected: ttd.length, median };
}

/** A coarse, honest word for an EER; the page always prints the number next to it. */
export function eerStrength(eer: number | null): "strong" | "moderate" | "weak" | "none" {
  if (eer === null) return "none";
  if (eer < 0.1) return "strong";
  if (eer < 0.25) return "moderate";
  return "weak";
}

/**
 * Recording provenance that the report itself doesn't carry, keyed by the exact `generated_at` it describes, so it
 * disappears (rather than going stale) the moment eval.json is regenerated. Source: IMPLEMENTATION.md §0.3 audit.
 */
const KNOWN_PROVENANCE: Record<string, { a: number; b: number }> = {
  "2026-09-26T18:59:00.019745+00:00": { a: 3, b: 1 },
};

export function recordingCounts(report: EvalReport): { a: number; b: number } | null {
  const r = report as EvalReport & { recordings?: { a?: number; b?: number } };
  if (r.recordings && typeof r.recordings.a === "number" && typeof r.recordings.b === "number") {
    return { a: r.recordings.a, b: r.recordings.b };
  }
  return KNOWN_PROVENANCE[report.generated_at] ?? null;
}

/** The optional `split` block sig_train_recordings.py adds (not in the frozen schema; read defensively). */
export function splitInfo(report: EvalReport): { train: Record<string, number>; test: Record<string, number>; purge_s: number | null } | null {
  const s = (report as EvalReport & { split?: unknown }).split;
  if (!s || typeof s !== "object") return null;
  const o = s as { training_counts?: unknown; test_counts?: unknown; purge_seconds?: unknown };
  const nums = (x: unknown): Record<string, number> =>
    x && typeof x === "object" ? Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, v]) => typeof v === "number")) as Record<string, number> : {};
  return { train: nums(o.training_counts), test: nums(o.test_counts), purge_s: typeof o.purge_seconds === "number" ? o.purge_seconds : null };
}
