"use client";

import { Fingerprint, Loader2, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip } from "recharts";

import { TipBox, type TipProps } from "@/components/charts/tip";
import { Progress } from "@/components/ui/progress";
import type { ContextLive, EnrollProgress, ModelInfo } from "@/lib/contracts";
import { MODALITIES, featureMeta, fmtClock, fmtValue, modalityColor, modalityIcon, modalityLabel, type FeatureMeta } from "@/lib/ui";

/** Raw feature values from the literal last tick (all blocks + temporal context) and the live context. */
export function liveFeatureValues(lastTick: Record<string, unknown> | null, context: ContextLive | null): Record<string, number> {
  const out: Record<string, number> = {};
  const take = (features: unknown) => {
    if (!features || typeof features !== "object") return;
    for (const [k, v] of Object.entries(features as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  };
  if (lastTick) {
    const blocks = lastTick.blocks;
    if (Array.isArray(blocks)) for (const b of blocks) if (b && typeof b === "object") take((b as { features?: unknown }).features);
    const ctx = lastTick.context;
    if (ctx && typeof ctx === "object") take((ctx as { features?: unknown }).features);
  }
  if (context) take(context.features);
  return out;
}

interface Axis {
  meta: FeatureMeta;
  median: number;
  live: number | null;
}

interface RadarRow {
  axis: string;
  you: number;
  live: number;
  meta: FeatureMeta;
  median: number;
  raw: number;
}

function RadarTip({ active, payload }: TipProps) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload as RadarRow;
  return (
    <TipBox>
      <div className="font-medium">{r.meta.label}</div>
      <div className="tnum mt-0.5 font-mono text-muted-foreground">
        live {fmtValue(r.raw, r.meta.unit)} · your median {fmtValue(r.median, r.meta.unit)}
      </div>
      <div className="tnum font-mono">{(r.live * 100).toFixed(0)}% of your median</div>
    </TipBox>
  );
}

export function IdentityCard({
  model,
  enroll,
  lastTick,
  context,
}: {
  model: ModelInfo | null;
  enroll: EnrollProgress | null;
  lastTick: Record<string, unknown> | null;
  context: ContextLive | null;
}) {
  const axes = useMemo<Axis[]>(() => {
    if (!model) return [];
    const live = liveFeatureValues(lastTick, context);
    const rows: Axis[] = [];
    for (const [key, median] of Object.entries(model.headline_medians)) {
      const meta = featureMeta(key);
      if (!meta || median === null || !Number.isFinite(median)) continue;
      rows.push({ meta, median, live: live[meta.name] ?? live[meta.column] ?? null });
    }
    rows.sort((a, b) => MODALITIES.indexOf(a.meta.modality) - MODALITIES.indexOf(b.meta.modality));
    return rows;
  }, [model, lastTick, context]);

  const radar: RadarRow[] = axes
    .filter((a) => a.live !== null && a.median !== 0)
    .map((a) => ({
      axis: a.meta.label,
      you: 1,
      live: Math.max(0, Math.min(2, (a.live as number) / a.median)),
      meta: a.meta,
      median: a.median,
      raw: a.live as number,
    }));

  const status = model?.status ?? "none";
  const showEnroll = !model || status !== "ready" || enroll?.mode === "enroll";

  return (
    <div className="space-y-4">
      {/* header line: v{n} · +k blocks learned · updated hh:mm */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Fingerprint className="size-4 text-brand" />
        {status === "ready" && model ? (
          <span className="tnum font-mono">
            <span className="font-semibold text-foreground">v{model.version ?? "?"}</span>
            <span className="text-muted-foreground"> · +{model.learned_since_enroll} blocks learned · updated {fmtClock(model.trained_at, false)}</span>
          </span>
        ) : status === "training" ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Training identity model…
          </span>
        ) : status === "failed" ? (
          <span className="inline-flex items-center gap-1.5 text-trust-suspicious">
            <TriangleAlert className="size-3.5" /> Training failed{model?.error ? `: ${model.error}` : ""}
          </span>
        ) : (
          <span className="text-muted-foreground">No identity model yet — collect a baseline, then Train.</span>
        )}
      </div>

      {model && status === "ready" && (
        <div className="flex flex-wrap gap-1.5">
          {MODALITIES.map((m) => {
            const Icon = modalityIcon(m);
            const on = model.enabled_modalities.includes(m);
            return (
              <span
                key={m}
                className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]"
                style={{ opacity: on ? 1 : 0.4 }}
                title={on ? `${modalityLabel(m)}: ${model.n_blocks[m] ?? 0} training blocks` : `${modalityLabel(m)}: disabled (too little data)`}
              >
                <Icon className="size-3" style={{ color: modalityColor(m) }} />
                <span className="tnum font-mono text-muted-foreground">{model.n_blocks[m] ?? 0}</span>
              </span>
            );
          })}
        </div>
      )}

      {radar.length >= 3 ? (
        <div>
          <div className="h-[230px]">
            <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height: 230 }}>
              <RadarChart data={radar} outerRadius="72%" margin={{ top: 4, right: 24, bottom: 4, left: 24 }}>
                <PolarGrid stroke="var(--grid)" />
                <PolarAngleAxis dataKey="axis" tick={{ fontSize: 9.5, fill: "var(--muted-foreground)" }} />
                <PolarRadiusAxis domain={[0, 2]} tick={false} axisLine={false} tickCount={3} />
                <Radar name="Your median" dataKey="you" stroke="var(--muted-foreground)" strokeDasharray="3 3" fill="var(--muted-foreground)" fillOpacity={0.06} isAnimationActive={false} />
                <Radar name="Live" dataKey="live" stroke="var(--brand)" strokeWidth={2} fill="var(--brand)" fillOpacity={0.16} isAnimationActive={false} dot={{ r: 2.5, fill: "var(--brand)" }} />
                <Tooltip content={RadarTip} isAnimationActive={false} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center justify-center gap-4 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0 w-4 border-t-2 border-dashed border-muted-foreground" /> your median (= 1.0)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded bg-brand" /> latest block ÷ median
            </span>
          </div>
        </div>
      ) : (
        axes.length > 0 && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            {axes.slice(0, 10).map((a) => (
              <div key={a.meta.name} className="flex justify-between gap-2 border-b border-dashed border-border/60 pb-1">
                <span className="truncate text-muted-foreground">{a.meta.label}</span>
                <span className="tnum font-mono">{fmtValue(a.median, a.meta.unit)}</span>
              </div>
            ))}
          </div>
        )
      )}

      {showEnroll && enroll && (
        <div className="space-y-2 rounded-lg bg-muted/40 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">Enrollment evidence</span>
            <span className={enroll.ready ? "text-trust-normal" : "text-muted-foreground"}>{enroll.ready ? "ready to train" : "collecting…"}</span>
          </div>
          {MODALITIES.map((m) => {
            const n = enroll.counts[m] ?? 0;
            const gate = enroll.gates[m] ?? 0;
            if (!gate) return null;
            return (
              <div key={m} className="grid grid-cols-[5.5rem_1fr_4.5rem] items-center gap-2 text-[11px]">
                <span className="text-muted-foreground">{modalityLabel(m, true)}</span>
                <Progress value={Math.min(100, (n / gate) * 100)} className="h-1.5" />
                <span className="tnum text-right font-mono text-muted-foreground">
                  {n}/{gate}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
