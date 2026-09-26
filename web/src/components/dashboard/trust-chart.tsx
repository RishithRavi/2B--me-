"use client";

import { useId, useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { TipBox, type TipProps } from "@/components/charts/tip";

import type { Level, MarkerPoint, TrustPoint } from "@/lib/contracts";
import { TRUST_CONFIG } from "@/lib/contracts";
import { useMounted, useNow } from "@/lib/hooks";
import { WINDOW_MS } from "@/lib/live";
import { takeoverIntervals } from "@/lib/ttd";
import { fmtClock, fmtPct, levelColor, levelLabel } from "@/lib/ui";

interface Row {
  t: number;
  c: number;
  level: Level;
}

const MARKER_STYLE: Record<MarkerPoint["label"], { color: string; label: string }> = {
  takeover_start: { color: "var(--trust-suspicious)", label: "takeover" },
  takeover_end: { color: "var(--muted-foreground)", label: "end" },
  rearm: { color: "var(--trust-watch)", label: "re-arm" },
  reset: { color: "var(--trust-learning)", label: "reset" },
  note: { color: "var(--muted-foreground)", label: "note" },
};

function ChartTooltip({ active, payload }: TipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload as Row;
  return (
    <TipBox>
      <div className="font-mono text-muted-foreground">{fmtClock(row.t)}</div>
      <div className="mt-0.5 flex items-center gap-2">
        <span className="size-2 rounded-full" style={{ background: levelColor(row.level) }} />
        <span className="tnum text-sm font-semibold">{fmtPct(row.c, 1)}</span>
        <span className="text-muted-foreground">{levelLabel(row.level)}</span>
      </div>
    </TipBox>
  );
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** 10-minute trust line: level-colored stroke, 80/40 bands, marker lines, shaded takeover interval. */
export function TrustChart({
  history,
  markers,
  height = 260,
  compact = false,
}: {
  history: TrustPoint[];
  markers: MarkerPoint[];
  height?: number;
  compact?: boolean;
}) {
  const now = useNow(1000);
  const mounted = useMounted();
  const uid = useId().replace(/:/g, "");
  const data = useMemo<Row[]>(
    () => history.map((p) => ({ t: Date.parse(p.t), c: p.confidence, level: p.level })).filter((r) => Number.isFinite(r.t)),
    [history],
  );
  const latestT = data.length ? data[data.length - 1].t : now;
  const xMax = Math.max(now, latestT);
  const xMin = xMax - WINDOW_MS;
  const intervals = takeoverIntervals(markers, xMax).filter((iv) => iv.to >= xMin);
  const visibleMarkers = markers.filter((m) => Date.parse(m.t) >= xMin);
  // Ticks on whole minutes (every 2 min) so labels never repeat.
  const ticks: number[] = [];
  for (let t = Math.ceil(xMin / 60_000) * 60_000; t <= xMax; t += 120_000) ticks.push(t);

  // Stroke gradient: hard stops at the 0.80 / 0.40 thresholds, mapped onto the line's own bounding box.
  const cs = data.map((d) => d.c);
  const hi = cs.length ? Math.max(...cs) : 1;
  const lo = cs.length ? Math.min(...cs) : 0;
  const span = hi - lo;
  const flat = span < 0.002;
  const o80 = flat ? 0 : clamp01((hi - TRUST_CONFIG.levels.normal) / span);
  const o40 = flat ? 0 : clamp01((hi - TRUST_CONFIG.levels.watch) / span);
  const last = data[data.length - 1];
  const solid = levelColor(last?.level === "locked" ? "locked" : last ? (last.c >= 0.8 ? "normal" : last.c >= 0.4 ? "watch" : "suspicious") : "learning");
  const lockedNow = last?.level === "locked";

  if (!mounted) return <div style={{ height }} className="w-full animate-pulse rounded-lg bg-muted/30" />;

  return (
    <div style={{ height }} className="relative w-full">
      {data.length === 0 && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-sm text-muted-foreground">
          Waiting for trust ticks from the agent…
        </div>
      )}
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height }}>
        <ComposedChart data={data} margin={{ top: compact ? 8 : 18, right: 34, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id={`stroke-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset={0} stopColor="var(--trust-normal)" />
              <stop offset={o80} stopColor="var(--trust-normal)" />
              <stop offset={o80} stopColor="var(--trust-watch)" />
              <stop offset={o40} stopColor="var(--trust-watch)" />
              <stop offset={o40} stopColor="var(--trust-suspicious)" />
              <stop offset={1} stopColor="var(--trust-suspicious)" />
            </linearGradient>
            <linearGradient id={`fill-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={solid} stopOpacity={0.16} />
              <stop offset="100%" stopColor={solid} stopOpacity={0} />
            </linearGradient>
            <pattern id={`hatch-${uid}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="var(--trust-suspicious)" fillOpacity={0.07} />
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--trust-suspicious)" strokeOpacity={0.22} strokeWidth={1.5} />
            </pattern>
          </defs>

          <CartesianGrid vertical={false} stroke="var(--grid)" />
          {/* level bands */}
          <ReferenceArea y1={TRUST_CONFIG.levels.normal} y2={1} fill="var(--trust-normal)" fillOpacity={0.04} ifOverflow="hidden" />
          <ReferenceArea y1={TRUST_CONFIG.levels.watch} y2={TRUST_CONFIG.levels.normal} fill="var(--trust-watch)" fillOpacity={0.035} ifOverflow="hidden" />
          <ReferenceArea y1={0} y2={TRUST_CONFIG.levels.watch} fill="var(--trust-suspicious)" fillOpacity={0.045} ifOverflow="hidden" />

          {/* takeover interval(s) */}
          {intervals.map((iv) => (
            <ReferenceArea
              key={iv.from}
              x1={Math.max(iv.from, xMin)}
              x2={iv.to}
              y1={0}
              y2={1}
              fill={`url(#hatch-${uid})`}
              ifOverflow="hidden"
            />
          ))}

          <ReferenceLine y={TRUST_CONFIG.levels.normal} stroke="var(--trust-normal)" strokeOpacity={0.55} strokeDasharray="4 4" label={{ value: "80", position: "right", fill: "var(--muted-foreground)", fontSize: 10 }} />
          <ReferenceLine y={TRUST_CONFIG.levels.watch} stroke="var(--trust-suspicious)" strokeOpacity={0.6} strokeDasharray="4 4" label={{ value: "40", position: "right", fill: "var(--muted-foreground)", fontSize: 10 }} />

          {visibleMarkers.map((m) => {
            const st = MARKER_STYLE[m.label] ?? MARKER_STYLE.note;
            return (
              <ReferenceLine
                key={`${m.t}-${m.label}`}
                x={Date.parse(m.t)}
                stroke={st.color}
                strokeWidth={1.25}
                strokeDasharray="2 3"
                label={compact ? undefined : { value: st.label, position: "top", fill: st.color, fontSize: 10 }}
              />
            );
          })}

          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[xMin, xMax]}
            allowDataOverflow
            tickFormatter={(v: number) => fmtClock(v, false)}
            ticks={ticks}
            stroke="var(--muted-foreground)"
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            minTickGap={40}
          />
          <YAxis
            domain={[0, 1]}
            ticks={[0, 0.4, 0.8, 1]}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            width={48}
          />
          <Tooltip content={ChartTooltip} cursor={{ stroke: "var(--muted-foreground)", strokeOpacity: 0.4, strokeDasharray: "3 3" }} isAnimationActive={false} />
          <Area
            type="monotoneX"
            dataKey="c"
            stroke={flat || lockedNow ? solid : `url(#stroke-${uid})`}
            strokeWidth={2.25}
            fill={`url(#fill-${uid})`}
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)", fill: solid }}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
