"use client";

import { useMemo } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { AXIS_TICK, TipBox, type TipProps } from "@/components/charts/tip";
import type { MarkerPoint, TrustSeries } from "@/lib/contracts";
import { TRUST_CONFIG } from "@/lib/contracts";
import { fmtClock, fmtPct } from "@/lib/ui";

interface Row {
  t: number;
  avg: number | null;
  band: [number, number] | null;
  min: number | null;
  max: number | null;
  stepups: number;
}

const MARKER_COLOR: Record<MarkerPoint["label"], string> = {
  takeover_start: "var(--trust-suspicious)",
  takeover_end: "var(--muted-foreground)",
  rearm: "var(--trust-watch)",
  reset: "var(--trust-learning)",
  note: "var(--muted-foreground)",
};

function Tip({ active, payload }: TipProps) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload as Row;
  return (
    <TipBox>
      <div className="font-mono text-muted-foreground">{fmtClock(r.t)}</div>
      {r.avg === null ? (
        <div className="mt-0.5 text-muted-foreground">no ticks (gap)</div>
      ) : (
        <div className="tnum mt-0.5 grid grid-cols-[auto_auto] gap-x-3 font-mono">
          <span className="text-muted-foreground">avg</span>
          <span className="font-semibold">{fmtPct(r.avg, 1)}</span>
          <span className="text-muted-foreground">min–max</span>
          <span>
            {fmtPct(r.min)}–{fmtPct(r.max)}
          </span>
          {r.stepups > 0 && (
            <>
              <span className="text-muted-foreground">step-ups</span>
              <span className="text-trust-watch">{r.stepups}</span>
            </>
          )}
        </div>
      )}
    </TipBox>
  );
}

/** Gap-filled session timeline from Tiger (`time_bucket_gapfill`): avg line inside a min–max band, with markers. */
export function TrustTimeline({ series, height = 260 }: { series: TrustSeries; height?: number }) {
  const data = useMemo<Row[]>(
    () =>
      series.points.map((p) => ({
        t: Date.parse(p.t),
        avg: p.avg,
        band: p.min !== null && p.max !== null ? [p.min, p.max] : null,
        min: p.min,
        max: p.max,
        stepups: p.n_stepups,
      })),
    [series],
  );
  if (!data.length) return <p className="py-8 text-center text-sm text-muted-foreground">No ticks in this session.</p>;
  const xMin = data[0].t;
  const xMax = data[data.length - 1].t;

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 800, height }}>
        <ComposedChart data={data} margin={{ top: 16, right: 30, bottom: 0, left: -12 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[xMin, xMax]}
            tickFormatter={(v: number) => fmtClock(v, false)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            minTickGap={48}
          />
          <YAxis domain={[0, 1]} ticks={[0, 0.4, 0.8, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tick={AXIS_TICK} tickLine={false} axisLine={false} width={48} />
          <ReferenceLine y={TRUST_CONFIG.levels.normal} stroke="var(--trust-normal)" strokeOpacity={0.5} strokeDasharray="4 4" />
          <ReferenceLine y={TRUST_CONFIG.levels.watch} stroke="var(--trust-suspicious)" strokeOpacity={0.55} strokeDasharray="4 4" />
          {series.markers.map((m) => (
            <ReferenceLine
              key={`${m.t}-${m.label}`}
              x={Date.parse(m.t)}
              stroke={MARKER_COLOR[m.label]}
              strokeDasharray="2 3"
              label={{ value: m.label.replace("_", " "), position: "top", fill: MARKER_COLOR[m.label], fontSize: 10 }}
            />
          ))}
          <Tooltip content={Tip} isAnimationActive={false} cursor={{ stroke: "var(--muted-foreground)", strokeOpacity: 0.4, strokeDasharray: "3 3" }} />
          <Area type="monotone" dataKey="band" stroke="none" fill="var(--brand)" fillOpacity={0.16} isAnimationActive={false} connectNulls={false} activeDot={false} />
          <Line type="monotone" dataKey="avg" stroke="var(--brand)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
