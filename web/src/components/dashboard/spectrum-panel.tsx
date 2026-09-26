"use client";

import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { AXIS_TICK, TipBox, type TipProps } from "@/components/charts/tip";
import type { ContextLive } from "@/lib/contracts";
import { fmtValue } from "@/lib/ui";

const MAX_HZ = 25;

interface Row {
  hz: number;
  live: number | null;
  enrolled: number | null;
}

/** Normalize to a share of total power so the two spectra compare by shape, not by activity level. */
function share(psd: number[] | null | undefined): number[] | null {
  if (!psd || psd.length === 0) return null;
  const sum = psd.reduce((a, b) => a + Math.max(0, b), 0);
  if (sum <= 0) return null;
  return psd.map((v) => (Math.max(0, v) / sum) * 100);
}

function SpecTip({ active, payload }: TipProps) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload as Row;
  return (
    <TipBox>
      <div className="tnum font-mono text-muted-foreground">{r.hz.toFixed(1)} Hz</div>
      <div className="tnum mt-0.5 grid grid-cols-[auto_auto] gap-x-3 font-mono">
        <span className="text-muted-foreground">live</span>
        <span>{r.live === null ? "—" : `${r.live.toFixed(1)}%`}</span>
        <span className="text-muted-foreground">enrolled</span>
        <span>{r.enrolled === null ? "—" : `${r.enrolled.toFixed(1)}%`}</span>
      </div>
    </TipBox>
  );
}

/** "Rhythm spectrum (FFT)": Welch PSD of input-event timing, live 30 s window vs A's enrolled mean. */
export function SpectrumPanel({ context, enrolledPsd, height = 190 }: { context: ContextLive | null; enrolledPsd: number[] | null; height?: number }) {
  const data = useMemo<Row[]>(() => {
    const live = share(context?.psd);
    const enr = share(context?.enrolled_psd ?? enrolledPsd);
    const n = Math.max(live?.length ?? 0, enr?.length ?? 0);
    return Array.from({ length: n }, (_, i) => ({
      hz: n > 1 ? (i * MAX_HZ) / (n - 1) : 0,
      live: live?.[i] ?? null,
      enrolled: enr?.[i] ?? null,
    }));
  }, [context, enrolledPsd]);

  const f = context?.features ?? {};
  const stats: [string, number | null | undefined, string][] = [
    ["dominant rhythm", f["tp.peak_hz"], "Hz"],
    ["centroid", f["tp.centroid_hz"], "Hz"],
    ["spectral entropy", f["tp.spec_entropy"], "bits"],
    ["burstiness", f["tp.B"], ""],
  ];

  if (!data.length) {
    return <p className="py-6 text-sm text-muted-foreground">Waiting for the 30 s temporal context window…</p>;
  }

  return (
    <div className="space-y-3">
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 360, height }}>
          <LineChart data={data} margin={{ top: 8, right: 10, bottom: 0, left: -8 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis
              dataKey="hz"
              type="number"
              domain={[0, MAX_HZ]}
              ticks={[0, 5, 10, 15, 20, 25]}
              tickFormatter={(v: number) => `${v}`}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              label={{ value: "Hz", position: "insideBottomRight", offset: -2, fill: "var(--muted-foreground)", fontSize: 10 }}
            />
            <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v.toFixed(0)}%`} width={44} />
            <Tooltip content={SpecTip} isAnimationActive={false} cursor={{ stroke: "var(--muted-foreground)", strokeOpacity: 0.4 }} />
            <Line type="monotone" dataKey="enrolled" name="Enrolled mean (A)" stroke="var(--muted-foreground)" strokeDasharray="4 3" strokeWidth={1.75} dot={false} isAnimationActive={false} connectNulls />
            <Line type="monotone" dataKey="live" name="Live (30 s)" stroke="var(--mod-temporal)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded" style={{ background: "var(--mod-temporal)" }} /> live 30 s window
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0 w-4 border-t-2 border-dashed border-muted-foreground" /> enrolled mean
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stats.map(([label, v, unit]) => (
          <div key={label} className="rounded-md bg-muted/40 px-2 py-1.5">
            <div className="text-[10px] text-muted-foreground">{label}</div>
            <div className="tnum font-mono text-sm">{typeof v === "number" ? fmtValue(v, unit) : "—"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
