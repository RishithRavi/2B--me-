"use client";

import { useId } from "react";

import type { TrustPoint } from "@/lib/contracts";
import { TRUST_CONFIG } from "@/lib/contracts";
import { WINDOW_MS } from "@/lib/live";

/**
 * Pure-SVG trust line (no axes) for the landing hero. The stroke gradient is in user space, so the
 * 0.80 / 0.40 color changes land exactly on the thresholds.
 */
export function TrustSparkline({ history, now, height = 120 }: { history: TrustPoint[]; now: number; height?: number }) {
  const uid = useId().replace(/:/g, "");
  const W = 600;
  const H = height;
  const pad = 6;
  const xMax = Math.max(now, ...history.map((p) => Date.parse(p.t)));
  const xMin = xMax - WINDOW_MS / 2;
  const pts = history
    .map((p) => ({ t: Date.parse(p.t), c: p.confidence, locked: p.level === "locked" }))
    .filter((p) => p.t >= xMin - 10_000);
  const x = (t: number) => ((t - xMin) / (xMax - xMin)) * W;
  const y = (c: number) => pad + (1 - c) * (H - 2 * pad);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.c).toFixed(1)}`).join(" ");
  const area = pts.length ? `${d} L${x(pts[pts.length - 1].t).toFixed(1)},${H} L${x(pts[0].t).toFixed(1)},${H} Z` : "";
  const locked = pts.length > 0 && pts[pts.length - 1].locked;
  const last = pts[pts.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full overflow-visible" aria-hidden>
      <defs>
        <linearGradient id={`spark-${uid}`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={H}>
          <stop offset={y(1) / H} stopColor="var(--trust-normal)" />
          <stop offset={y(TRUST_CONFIG.levels.normal) / H} stopColor="var(--trust-normal)" />
          <stop offset={y(TRUST_CONFIG.levels.normal) / H} stopColor="var(--trust-watch)" />
          <stop offset={y(TRUST_CONFIG.levels.watch) / H} stopColor="var(--trust-watch)" />
          <stop offset={y(TRUST_CONFIG.levels.watch) / H} stopColor="var(--trust-suspicious)" />
          <stop offset={1} stopColor="var(--trust-suspicious)" />
        </linearGradient>
        <linearGradient id={`spark-fill-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.14} />
          <stop offset="100%" stopColor="var(--brand)" stopOpacity={0} />
        </linearGradient>
      </defs>
      {[TRUST_CONFIG.levels.normal, TRUST_CONFIG.levels.watch].map((lvl) => (
        <line key={lvl} x1={0} x2={W} y1={y(lvl)} y2={y(lvl)} stroke="var(--muted-foreground)" strokeOpacity={0.25} strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
      ))}
      {area && <path d={area} fill={`url(#spark-fill-${uid})`} />}
      {d && (
        <path
          d={d}
          fill="none"
          stroke={locked ? "var(--trust-locked)" : `url(#spark-${uid})`}
          strokeWidth={2.25}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {last && <circle cx={x(last.t)} cy={y(last.c)} r={3.5} fill="var(--foreground)" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
