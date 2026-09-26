"use client";

import { CheckCircle2, CircleX } from "lucide-react";
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { AXIS_TICK, TipBox, type TipProps } from "@/components/charts/tip";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { EvalReport, HearsayReport, Modality, RedteamReport } from "@/lib/contracts";
import { MODALITIES, fmtClock, fmtPct, modalityColor, modalityIcon, modalityLabel } from "@/lib/ui";
import { cn } from "@/lib/utils";

const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "—" : fmtPct(v, d));
const num = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "—" : v.toFixed(d));

// ---------------------------------------------------------------------------
// ROC
// ---------------------------------------------------------------------------

function RocTip({ active, payload }: TipProps) {
  if (!active || !payload?.length) return null;
  return (
    <TipBox>
      {payload.map((p) => {
        const row = p.payload as { fpr: number; tpr: number; m: Modality };
        return (
          <div key={String(p.name)} className="tnum flex items-center gap-2 font-mono">
            <span className="size-2 rounded-full" style={{ background: p.color }} />
            <span className="text-muted-foreground">{String(p.name)}</span>
            <span>
              FPR {row.fpr.toFixed(2)} · TPR {row.tpr.toFixed(2)}
            </span>
          </div>
        );
      })}
    </TipBox>
  );
}

export function RocChart({ report, height = 320 }: { report: EvalReport; height?: number }) {
  const series = useMemo(
    () =>
      MODALITIES.filter((m) => report.modalities[m]?.roc?.length).map((m) => ({
        m,
        data: (report.modalities[m]?.roc ?? []).map(([fpr, tpr]) => ({ fpr, tpr, m })),
      })),
    [report],
  );
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 480, height }}>
        <LineChart margin={{ top: 8, right: 12, bottom: 16, left: 12 }}>
          <CartesianGrid stroke="var(--grid)" />
          <XAxis
            dataKey="fpr"
            type="number"
            domain={[0, 1]}
            ticks={[0, 0.25, 0.5, 0.75, 1]}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            label={{ value: "false accept rate (B accepted as A)", position: "insideBottom", offset: -8, fill: "var(--muted-foreground)", fontSize: 10 }}
          />
          <YAxis
            dataKey="tpr"
            type="number"
            domain={[0, 1]}
            ticks={[0, 0.25, 0.5, 0.75, 1]}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={36}
            label={{ value: "true accept rate", angle: -90, position: "left", offset: 0, fill: "var(--muted-foreground)", fontSize: 10 }}
          />
          <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="var(--muted-foreground)" strokeDasharray="4 4" strokeOpacity={0.5} />
          <ReferenceLine segment={[{ x: 0, y: 1 }, { x: 1, y: 0 }]} stroke="var(--muted-foreground)" strokeDasharray="1 4" strokeOpacity={0.35} />
          <Tooltip content={RocTip} isAnimationActive={false} />
          <Legend verticalAlign="top" height={28} iconType="plainline" itemSorter={null} wrapperStyle={{ fontSize: 11, color: "var(--muted-foreground)" }} />
          {series.map((s) => (
            <Line
              key={s.m}
              data={s.data}
              dataKey="tpr"
              name={modalityLabel(s.m, true)}
              type="linear"
              stroke={modalityColor(s.m)}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function EerTable({ report }: { report: EvalReport }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Branch</TableHead>
          <TableHead className="text-right">AUC</TableHead>
          <TableHead className="text-right">EER</TableHead>
          <TableHead className="text-right">blocks A / B</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {MODALITIES.map((m) => {
          const r = report.modalities[m];
          if (!r) return null;
          const Icon = modalityIcon(m);
          return (
            <TableRow key={m}>
              <TableCell>
                <span className="inline-flex items-center gap-2">
                  <Icon className="size-3.5" style={{ color: modalityColor(m) }} />
                  {modalityLabel(m, true)}
                  {r.weak && (
                    <Badge variant="outline" className="h-4 px-1.5 text-[9px] text-trust-watch">
                      weak
                    </Badge>
                  )}
                </span>
              </TableCell>
              <TableCell className="tnum text-right font-mono text-xs">{num(r.auc)}</TableCell>
              <TableCell className="tnum text-right font-mono text-xs">{pct(r.eer)}</TableCell>
              <TableCell className="tnum text-right font-mono text-xs text-muted-foreground">
                {r.n_genuine} / {r.n_impostor}
              </TableCell>
            </TableRow>
          );
        })}
        <TableRow className="bg-muted/40 font-medium">
          <TableCell>Fused (all branches)</TableCell>
          <TableCell className="tnum text-right font-mono text-xs">{num(report.fused.auc)}</TableCell>
          <TableCell className="tnum text-right font-mono text-xs text-trust-normal">{pct(report.fused.eer)}</TableCell>
          <TableCell />
        </TableRow>
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Branch ablation
// ---------------------------------------------------------------------------

interface AblRow {
  label: string;
  m: Modality;
  eer: number;
  delta: number;
}

function AblTip({ active, payload }: TipProps) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload as AblRow;
  return (
    <TipBox>
      <div className="font-medium">Fused without {r.label.toLowerCase()}</div>
      <div className="tnum font-mono text-muted-foreground">
        EER {pct(r.eer)} ({r.delta >= 0 ? "+" : ""}
        {(r.delta * 100).toFixed(1)} pts vs all branches)
      </div>
    </TipBox>
  );
}

export function AblationChart({ report, height = 240 }: { report: EvalReport; height?: number }) {
  const full = report.fused.eer ?? 0;
  const data: AblRow[] = report.ablation
    .filter((a) => a.fused_eer !== null)
    .map((a) => ({ label: modalityLabel(a.removed, true), m: a.removed, eer: a.fused_eer as number, delta: (a.fused_eer as number) - full }));
  const max = Math.ceil((Math.max(full, ...data.map((d) => d.eer)) * 1.15) / 0.05) * 0.05 || 0.2;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 480, height }}>
        <BarChart data={data} layout="vertical" margin={{ top: 20, right: 44, bottom: 4, left: 8 }} barCategoryGap={8}>
          <CartesianGrid horizontal={false} stroke="var(--grid)" />
          <XAxis type="number" domain={[0, max]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
          <YAxis type="category" dataKey="label" width={86} tick={{ ...AXIS_TICK, fontSize: 11 }} tickFormatter={(v: string) => `− ${v}`} tickLine={false} axisLine={false} />
          <ReferenceLine x={full} stroke="var(--trust-normal)" strokeDasharray="4 3" label={{ value: `all ${pct(full)}`, position: "top", fill: "var(--trust-normal)", fontSize: 10 }} />
          <Tooltip content={AblTip} cursor={{ fill: "var(--muted)", fillOpacity: 0.4 }} isAnimationActive={false} />
          <Bar
            dataKey="eer"
            radius={[0, 4, 4, 0]}
            isAnimationActive={false}
            label={{ position: "right", fill: "var(--muted-foreground)", fontSize: 10, formatter: (v: unknown) => (typeof v === "number" ? pct(v) : "") }}
          >
            {data.map((d) => (
              <Cell key={d.m} fill={modalityColor(d.m)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Identification confusion matrix
// ---------------------------------------------------------------------------

export function ConfusionMatrix({ report }: { report: EvalReport }) {
  const id = report.identification;
  if (!id) return <p className="text-sm text-muted-foreground">No identification run in this report.</p>;
  const n = id.labels.length;
  return (
    <div className="space-y-3">
      <div className="grid gap-1.5" style={{ gridTemplateColumns: `auto repeat(${n}, minmax(0, 1fr))` }}>
        <div />
        {id.labels.map((l) => (
          <div key={l} className="pb-1 text-center font-mono text-[11px] text-muted-foreground">
            predicted {l.toUpperCase()}
          </div>
        ))}
        {id.confusion.map((row, i) => {
          const total = row.reduce((a, b) => a + b, 0) || 1;
          return [
            <div key={`h${i}`} className="flex items-center pr-2 font-mono text-[11px] text-muted-foreground">
              actual {id.labels[i].toUpperCase()}
            </div>,
            ...row.map((v, j) => {
              const frac = v / total;
              const diag = i === j;
              return (
                <div
                  key={`${i}-${j}`}
                  className="flex aspect-[1.6] flex-col items-center justify-center rounded-lg ring-1 ring-foreground/10"
                  style={{ background: `color-mix(in oklch, ${diag ? "var(--brand)" : "var(--trust-suspicious)"} ${Math.round(8 + frac * 55)}%, transparent)` }}
                  title={`${v} of ${total} blocks`}
                >
                  <span className="tnum text-2xl font-semibold">{v}</span>
                  <span className="tnum font-mono text-[11px] text-muted-foreground">{fmtPct(frac)}</span>
                </div>
              );
            }),
          ];
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Who typed this block? Accuracy <b className="tnum text-foreground">{pct(id.accuracy)}</b> over {id.confusion.flat().reduce((a, b) => a + b, 0)} held-out blocks.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live TTD trials
// ---------------------------------------------------------------------------

export function TtdTrials({ report }: { report: EvalReport }) {
  const trials = report.live_trials;
  if (!trials.length) return <p className="text-sm text-muted-foreground">No live takeover trials recorded yet.</p>;
  const detected = trials.filter((t) => t.detected && t.ttd_s !== null).map((t) => t.ttd_s as number);
  const sorted = [...detected].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  const max = Math.max(75, ...detected);
  return (
    <div className="space-y-3">
      <div className="flex gap-6">
        <div>
          <div className="eyebrow">median TTD</div>
          <div className="tnum text-3xl font-semibold">{median !== null ? `${Math.round(median)} s` : "—"}</div>
        </div>
        <div>
          <div className="eyebrow">detected</div>
          <div className="tnum text-3xl font-semibold">
            {detected.length}/{trials.length}
          </div>
        </div>
      </div>
      <ol className="space-y-1.5">
        {trials.map((t, i) => (
          <li key={t.t_start + i} className="grid grid-cols-[4.5rem_1fr_3.5rem] items-center gap-3 text-xs">
            <span className="tnum font-mono text-muted-foreground">{fmtClock(t.t_start, false)}</span>
            <div className="relative h-2 rounded-full bg-muted">
              {t.ttd_s !== null && (
                <div
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${Math.min(100, (t.ttd_s / max) * 100)}%`, background: t.detected ? "var(--brand)" : "var(--trust-suspicious)" }}
                />
              )}
              <div className="absolute inset-y-[-3px] w-px bg-trust-watch" style={{ left: `${(60 / max) * 100}%` }} title="60 s target" />
            </div>
            <span className={cn("tnum flex items-center justify-end gap-1 font-mono", !t.detected && "text-trust-suspicious")}>
              {t.detected ? <CheckCircle2 className="size-3 text-trust-normal" /> : <CircleX className="size-3" />}
              {t.ttd_s !== null ? `${Math.round(t.ttd_s)}s` : "—"}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-[11px] text-muted-foreground">
        From the operator&apos;s takeover marker to the first trust tick below 40%. The amber tick marks the 60 s target.
      </p>
      {report.splice && (
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted/40 p-3 text-xs sm:grid-cols-4">
          <div>
            <div className="text-muted-foreground">splice replays</div>
            <div className="tnum font-mono">{report.splice.n}</div>
          </div>
          <div>
            <div className="text-muted-foreground">TTD median / p90</div>
            <div className="tnum font-mono">
              {num(report.splice.ttd_s.median, 0)} / {num(report.splice.ttd_s.p90, 0)} s
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">undetected at 300 s</div>
            <div className="tnum font-mono">{pct(report.splice.undetected_300s_frac)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">R3 friction</div>
            <div className="tnum font-mono">{pct(report.splice.r3_friction_frac)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Voice red team
// ---------------------------------------------------------------------------

function FarCell({ v, strong }: { v: number | null; strong?: boolean }) {
  if (v === null) return <span className="text-muted-foreground">—</span>;
  const color = v === 0 ? "var(--trust-normal)" : v >= 0.2 ? "var(--trust-suspicious)" : "var(--trust-watch)";
  return (
    <span className={cn("tnum font-mono text-xs", strong && "font-semibold")} style={{ color }}>
      {fmtPct(v, 0)}
    </span>
  );
}

export function RedteamTable({ report }: { report: RedteamReport }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant="outline">delivery: {report.delivery}</Badge>
        <Badge variant="outline" className="font-mono">
          genuine FRR {pct(report.genuine.frr, 0)} · n={report.genuine.n}
        </Badge>
        <Badge variant="outline" className="font-mono">
          human impostor FAR {pct(report.impostor.far, 0)} · n={report.impostor.n}
        </Badge>
        {Object.entries(report.thresholds).map(([k, v]) => (
          <Badge key={k} variant="outline" className="font-mono text-muted-foreground">
            {k}={v}
          </Badge>
        ))}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Attack class</TableHead>
            <TableHead className="text-right">n</TableHead>
            <TableHead className="text-right">Speaker match only</TableHead>
            <TableHead className="text-right">Anti-spoof only</TableHead>
            <TableHead className="text-right">Fused (2bME)</TableHead>
            <TableHead className="text-right">mean speaker cos</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.attacks.map((a) => (
            <TableRow key={`${a.class}-${a.generator}`}>
              <TableCell>
                <div className="font-mono text-xs">{a.class}</div>
                <div className="text-[11px] text-muted-foreground">{a.generator}</div>
              </TableCell>
              <TableCell className="tnum text-right font-mono text-xs">{a.n}</TableCell>
              <TableCell className="text-right">
                <FarCell v={a.far_asv_only} />
              </TableCell>
              <TableCell className="text-right">
                <FarCell v={a.far_cm_only} />
              </TableCell>
              <TableCell className="text-right">
                <FarCell v={a.far_fused} strong />
              </TableCell>
              <TableCell className="tnum text-right font-mono text-xs text-muted-foreground">{num(a.mean_asv_cos)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-[11px] text-muted-foreground">
        FAR is the share of attacks accepted as the owner. The &ldquo;speaker match only&rdquo; column shows why a speaker embedding alone
        isn&apos;t enough: clones sound like you.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hearsay
// ---------------------------------------------------------------------------

export function HearsayCard({ report }: { report: HearsayReport }) {
  const fusion =
    typeof report.fusion === "string"
      ? report.fusion
      : report.fusion && typeof report.fusion === "object" && "method" in report.fusion
        ? String((report.fusion as { method: unknown }).method)
        : null;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["minDCF (a)", num(report.dev.min_dcf_a, 3)],
          ["minDCF (b)", num(report.dev.min_dcf_b, 3)],
          ["EER", pct(report.dev.eer)],
          ["dev utterances", report.dev.n.toLocaleString()],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg bg-muted/40 p-3">
            <div className="text-[11px] text-muted-foreground">{k}</div>
            <div className="tnum mt-0.5 text-xl font-semibold">{v}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {fusion && <Badge variant="outline">fusion: {fusion.replaceAll("_", " ")}</Badge>}
        <Badge variant="outline" className={report.rules_confirmed ? "text-trust-normal" : "text-trust-watch"}>
          {report.rules_confirmed ? "rules confirmed" : "rules not yet confirmed"}
        </Badge>
      </div>
      {report.detectors.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Detector</TableHead>
              <TableHead className="text-right">minDCF (a)</TableHead>
              <TableHead className="text-right">minDCF (b)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.detectors.map((d) => (
              <TableRow key={d.name}>
                <TableCell className="font-mono text-xs">{d.name}</TableCell>
                <TableCell className="tnum text-right font-mono text-xs">{num(d.min_dcf_a, 3)}</TableCell>
                <TableCell className="tnum text-right font-mono text-xs">{num(d.min_dcf_b, 3)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
