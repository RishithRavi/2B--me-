// Tiny presentation helpers shared by every page. Pure (no React state); safe to unit-test.
import {
  Activity,
  AppWindow,
  Keyboard,
  MousePointer2,
  ScrollText,
  type LucideIcon,
} from "lucide-react";

import { FEATURE_SPEC, TRUST_CONFIG, type Level, type Modality } from "./contracts";

export const MODALITIES: readonly Modality[] = ["keyboard", "mouse", "scroll", "workflow", "temporal"];

export const LEVELS: readonly Level[] = ["normal", "watch", "suspicious", "locked", "learning"];

const LEVEL_LABEL: Record<Level, string> = {
  normal: "Normal",
  watch: "Watch",
  suspicious: "Suspicious",
  locked: "Locked",
  learning: "Learning",
};

/** CSS color (a var() reference) for a trust level. Unknown/missing → learning. */
export function levelColor(level: Level | null | undefined): string {
  const l: Level = level && level in LEVEL_LABEL ? level : "learning";
  return `var(--trust-${l})`;
}

export function levelLabel(level: Level | null | undefined): string {
  return level && level in LEVEL_LABEL ? LEVEL_LABEL[level] : "Unknown";
}

/** Band for a raw confidence (engine semantics: normal ≥ 0.80, watch 0.40–0.80, suspicious < 0.40). */
export function levelFromConfidence(conf: number): Level {
  if (conf >= TRUST_CONFIG.levels.normal) return "normal";
  if (conf >= TRUST_CONFIG.levels.watch) return "watch";
  return "suspicious";
}

/** 0.9712 → "97%"; digits controls decimals. null/NaN → "—". */
export function fmtPct(conf: number | null | undefined, digits = 0): string {
  if (conf === null || conf === undefined || !Number.isFinite(conf)) return "—";
  return `${(conf * 100).toFixed(digits)}%`;
}

/** ISO timestamp → "just now" / "12s ago" / "3m ago" / "2h ago" / "4d ago". */
export function fmtAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 3) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Seconds → "4.2s" / "38s" / "3m 05s" / "1h 02m". */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, seconds);
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** ISO → local "14:30:05" (or "14:30" with seconds=false). */
export function fmtClock(iso: string | number | null | undefined, seconds = true): string {
  if (iso === null || iso === undefined) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: seconds ? "2-digit" : undefined,
    hour12: false,
  });
}

/** Signed z-score: 3.14 → "+3.1σ", -2 → "−2.0σ". */
export function fmtZ(z: number | null | undefined): string {
  if (z === null || z === undefined || !Number.isFinite(z)) return "—";
  const sign = z >= 0 ? "+" : "−";
  return `${sign}${Math.abs(z).toFixed(1)}σ`;
}

/** Signed small number: 0.123 → "+0.12". */
export function fmtSigned(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const sign = x >= 0 ? "+" : "−";
  return `${sign}${Math.abs(x).toFixed(digits)}`;
}

/** Cents → "$2,000.00". */
export function fmtMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Bytes → "12.3 MB". */
export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Feature value with its spec unit: (182.3, "ms") → "182 ms". */
export function fmtValue(v: number | null | undefined, unit: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const num = abs >= 100 ? v.toFixed(0) : abs >= 10 ? v.toFixed(1) : abs >= 1 ? v.toFixed(2) : v.toFixed(3);
  if (unit === "frac") return `${(v * 100).toFixed(0)}%`;
  return unit ? `${num} ${unit}` : num;
}

export function modalityColor(m: Modality | string): string {
  return (MODALITIES as readonly string[]).includes(m) ? `var(--mod-${m})` : "var(--muted-foreground)";
}

const MODALITY_ICON: Record<Modality, LucideIcon> = {
  keyboard: Keyboard,
  mouse: MousePointer2,
  scroll: ScrollText,
  workflow: AppWindow,
  temporal: Activity,
};

export function modalityIcon(m: Modality | string): LucideIcon {
  return MODALITY_ICON[m as Modality] ?? Activity;
}

const MODALITY_LABEL: Record<Modality, string> = {
  keyboard: "Keyboard",
  mouse: "Mouse / trackpad",
  scroll: "Scroll",
  workflow: "Workflow",
  temporal: "Temporal",
};

export function modalityLabel(m: Modality | string, short = false): string {
  if (short && m === "mouse") return "Mouse";
  return MODALITY_LABEL[m as Modality] ?? m;
}

// ---------------------------------------------------------------------------
// Feature lookup by spec name ("kb.hold_p50") or DB column ("kb_hold_p50").
// ---------------------------------------------------------------------------

export interface FeatureMeta {
  name: string;
  column: string;
  label: string;
  unit: string;
  headline: boolean;
  modality: Modality;
}

const FEATURE_BY_KEY: Record<string, FeatureMeta> = {};
export const ALL_FEATURES: FeatureMeta[] = [];
for (const [m, spec] of Object.entries(FEATURE_SPEC.modalities)) {
  for (const f of spec.features) {
    const meta: FeatureMeta = { ...f, modality: m as Modality };
    ALL_FEATURES.push(meta);
    FEATURE_BY_KEY[f.name] = meta;
    FEATURE_BY_KEY[f.column] = meta;
  }
}

export function featureMeta(key: string): FeatureMeta | null {
  return FEATURE_BY_KEY[key] ?? null;
}

/** Human feature label, falling back to the raw key. */
export function featureLabel(key: string): string {
  return FEATURE_BY_KEY[key]?.label ?? key;
}

/** FeedItem severity (server-authored): 0 info · 1 notice · 2 warn · 3 alert · 4 high · 5 lock. */
export type Tone = "info" | "notice" | "warn" | "alert" | "high" | "lock";
export function feedTone(severity: number): Tone {
  if (severity >= 5) return "lock";
  if (severity === 4) return "high";
  if (severity === 3) return "alert";
  if (severity === 2) return "warn";
  if (severity === 1) return "notice";
  return "info";
}

export function toneColor(t: Tone): string {
  switch (t) {
    case "lock":
      return "var(--trust-locked)";
    case "high":
    case "alert":
      return "var(--trust-suspicious)";
    case "warn":
      return "var(--trust-watch)";
    case "notice":
      return "var(--trust-learning)";
    default:
      return "var(--muted-foreground)";
  }
}

export function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  return id.length > 8 ? id.slice(0, 8) : id;
}
