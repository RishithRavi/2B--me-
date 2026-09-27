"use client";

import { CheckCircle2, CircleDashed, CircleX, FlaskConical, Info, type LucideIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { AXIS_TICK, TipBox, type TipProps } from "@/components/charts/tip";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip as UiTooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { EvalReport, HearsayReport, Modality, RedteamReport } from "@/lib/contracts";
import { MODALITIES, fmtClock, fmtPct, modalityColor, modalityIcon, modalityLabel } from "@/lib/ui";
import { cn } from "@/lib/utils";

import {
  ALERT_THRESHOLD,
  LIVE_TRIALS_TARGET,
  blockTotals,
  dataKind,
  disabledReasons,
  eerPoint,
  eerStrength,
  identificationRan,
  impostorReuse,
  liveTrialStats,
  measuredModalities,
  operatingRows,
  recordingCounts,
  splitInfo,
  tunedOnImpostor,
} from "./metrics";

const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "—" : fmtPct(v, d));
const num = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "—" : v.toFixed(d));

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** Honest empty state for something we haven't measured yet (dashed, so it never reads as a result). */
export function NotMeasured({ icon: Icon = CircleDashed, title, children, className }: { icon?: LucideIcon; title: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-full min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-5 py-8 text-center", className)}>
      <Icon className="size-5 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="max-w-md text-xs leading-relaxed text-muted-foreground">{children}</div>}
    </div>
  );
}

const STRENGTH: Record<ReturnType<typeof eerStrength>, { label: string; color: string }> = {
  strong: { label: "strong", color: "var(--trust-normal)" },
  moderate: { label: "moderate", color: "var(--trust-watch)" },
  weak: { label: "weak", color: "var(--trust-suspicious)" },
  none: { label: "not measured", color: "var(--muted-foreground)" },
};

function Stat({ label, value, sub, badge }: { label: string; value: ReactNode; sub?: ReactNode; badge?: ReactNode }) {
  return (
    <div className="panel flex min-w-0 flex-col gap-1 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow truncate">{label}</span>
        {badge}
      </div>
      <div className="tnum text-3xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="text-xs leading-snug text-muted-foreground">{sub}</div>}
    </div>
  );
}

function StrengthBadge({ eer }: { eer: number | null }) {
  const s = STRENGTH[eerStrength(eer)];
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium" style={{ borderColor: `color-mix(in oklch, ${s.color} 45%, transparent)` }}>
      <span className="size-1.5 rounded-full" style={{ background: s.color }} />
      <span className="text-foreground">{s.label} evidence</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Headline strip
// ---------------------------------------------------------------------------

export function EvidenceSummary({ report }: { report: EvalReport }) {
  const measured = measuredModalities(report);
  const disabled = disabledReasons(report.notes);
  const trials = liveTrialStats(report);
  const blocks = blockTotals(report);
  const missing = MODALITIES.filter((m) => !measured.includes(m));
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Stat
        label="Fused A-vs-not-A EER"
        value={pct(report.fused.eer)}
        badge={<StrengthBadge eer={report.fused.eer} />}
        sub={
          <>
            AUC {num(report.fused.auc)}. The equal-error rate is where false accepts equal false rejects; lower is better.
            {tunedOnImpostor(report) && " Optimistic: not-A also helped tune the model."}
          </>
        }
      />
      <Stat
        label="Branches measured"
        value={
          <>
            {measured.length}
            <span className="text-lg text-muted-foreground"> of {MODALITIES.length}</span>
          </>
        }
        sub={
          missing.length ? (
            <>
              {missing.map((m) => modalityLabel(m, true).toLowerCase()).join(", ")}: {Object.keys(disabled).length ? "not enough of A's data yet" : "no curve in this report"}
            </>
          ) : (
            "every branch of the signature has a held-out curve"
          )
        }
      />
      <Stat
        label="Live takeover trials"
        value={
          <>
            {trials.n}
            <span className="text-lg text-muted-foreground"> of {LIVE_TRIALS_TARGET}</span>
          </>
        }
        sub={trials.median !== null ? `median time to detection ${Math.round(trials.median)} s` : "marked takeovers with a stopwatch; none recorded yet"}
      />
      <Stat
        label="Held-out blocks"
        value={
          <>
            {blocks.a}
            <span className="text-lg text-muted-foreground"> A · </span>
            {blocks.b}
            <span className="text-lg text-muted-foreground"> not-A</span>
          </>
        }
        sub="A is the enrolled owner; not-A is a teammate. Nobody else's data is used."
      />
    </div>
  );
}

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
              FAR {fmtPct(row.fpr)} · FRR {fmtPct(1 - row.tpr)}
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
        eer: eerPoint(report.modalities[m]?.roc ?? []),
      })),
    [report],
  );
  const fused = report.fused.eer;
  if (!series.length && fused === null) {
    return <NotMeasured title="No ROC curves in this report">Each branch needs enough held-out blocks from A and from not-A before it gets a curve.</NotMeasured>;
  }
  return (
    <div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 480, height }}>
          <LineChart margin={{ top: 8, right: 16, bottom: 18, left: 12 }}>
            <CartesianGrid stroke="var(--grid)" />
            <XAxis
              dataKey="fpr"
              type="number"
              domain={[0, 1]}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              label={{ value: "false accepts (not-A passed as A)", position: "insideBottom", offset: -10, fill: "var(--muted-foreground)", fontSize: 10 }}
            />
            <YAxis
              dataKey="tpr"
              type="number"
              domain={[0, 1]}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={40}
              label={{ value: "A accepted as A", angle: -90, position: "left", offset: 2, fill: "var(--muted-foreground)", fontSize: 10 }}
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
            {series.map((s) =>
              s.eer ? <ReferenceDot key={`eer-${s.m}`} x={s.eer.far} y={1 - s.eer.frr} r={4} fill={modalityColor(s.m)} stroke="var(--card)" strokeWidth={2} /> : null,
            )}
            {fused !== null && (
              <ReferenceDot
                x={fused}
                y={1 - fused}
                r={6}
                fill="var(--foreground)"
                stroke="var(--card)"
                strokeWidth={2}
                label={{ value: `fused EER ${pct(fused)}`, position: "right", offset: 10, fill: "var(--foreground)", fontSize: 11, fontWeight: 600 }}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        Dashed diagonal = chance. Dots mark each curve&apos;s equal-error point on the dotted EER line; the white dot is the fused score (the report
        carries its EER, not a fused curve). Up and to the left is better.
      </p>
    </div>
  );
}

export function EerTable({ report }: { report: EvalReport }) {
  const disabled = disabledReasons(report.notes);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Branch</TableHead>
          <TableHead className="text-right">AUC</TableHead>
          <TableHead className="text-right">EER</TableHead>
          <TableHead className="text-right">A / not-A</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {MODALITIES.map((m) => {
          const r = report.modalities[m];
          const Icon = modalityIcon(m);
          const label = (
            <span className="inline-flex items-center gap-2">
              <Icon className="size-3.5" style={{ color: modalityColor(m) }} />
              {modalityLabel(m, true)}
            </span>
          );
          if (!r || r.auc === null) {
            return (
              <TableRow key={m}>
                <TableCell>{label}</TableCell>
                <TableCell colSpan={3} className="text-right whitespace-normal">
                  <span className="inline-flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
                    <CircleDashed className="size-3 shrink-0" />
                    not measured
                  </span>
                  {disabled[m] && <div className="text-[10px] text-muted-foreground/80">{disabled[m].toLowerCase()}</div>}
                </TableCell>
              </TableRow>
            );
          }
          return (
            <TableRow key={m}>
              <TableCell>
                <span className="inline-flex items-center gap-2">
                  {label}
                  {r.weak && (
                    <UiTooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="outline" className="h-4 cursor-help px-1.5 text-[9px] text-muted-foreground">
                          weak fit
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-64">The impostor-shape fit (β) was unstable or had fewer than 10 blocks, so this branch keeps the default β = 6.</TooltipContent>
                    </UiTooltip>
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
          <TableCell>Fused (weighted)</TableCell>
          <TableCell className="tnum text-right font-mono text-xs">{num(report.fused.auc)}</TableCell>
          <TableCell className="tnum text-right font-mono text-xs">{pct(report.fused.eer)}</TableCell>
          <TableCell className="text-right text-[11px] font-normal text-muted-foreground">60 s windows</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// FAR / FRR operating points
// ---------------------------------------------------------------------------

const BUDGETS = [0.05, 0.1, 0.2] as const;

export function OperatingPoints({ report }: { report: EvalReport }) {
  const [budget, setBudget] = useState<number>(0.1);
  const rows = operatingRows(report, budget);
  const splice = report.splice ?? null;
  const fa040 = splice?.fa_per_hour?.[ALERT_THRESHOLD.toFixed(2)] ?? null;

  return (
    <div className="space-y-4">
      {splice ? (
        <div className="grid grid-cols-3 gap-2">
          {[
            ["false alarms / h", fa040 === null ? "—" : fa040.toFixed(1), "owner challenged by mistake"],
            ["missed in 300 s", pct(splice.undetected_300s_frac, 0), "takeovers never flagged"],
            ["R3 friction", pct(splice.r3_friction_frac, 0), "owner's $2,000 order stepped up"],
          ].map(([k, v, s]) => (
            <div key={k} className="rounded-lg bg-muted/40 p-2.5">
              <div className="text-[10px] text-muted-foreground">{k}</div>
              <div className="tnum text-lg font-semibold">{v}</div>
              <div className="text-[10px] leading-snug text-muted-foreground">{s}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="flex gap-2 rounded-lg bg-muted/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>
            The live alert fires when fused trust stays under {Math.round(ALERT_THRESHOLD * 100)}% for 2 ticks. Measuring FAR/FRR at exactly that cut needs
            replayed trust over time (the splice replay), which this report doesn&apos;t have yet. Until then, these are block-level operating points read
            off the ROC above.
          </span>
        </p>
      )}

      {rows.length ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Hold false accepts at or below</span>
            <div className="inline-flex rounded-lg border p-0.5" role="group" aria-label="false-accept budget">
              {BUDGETS.map((b) => (
                <button
                  key={b}
                  type="button"
                  aria-pressed={budget === b}
                  onClick={() => setBudget(b)}
                  className={cn(
                    "tnum rounded-md px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors",
                    budget === b && "bg-muted text-foreground",
                  )}
                >
                  {Math.round(b * 100)}%
                </button>
              ))}
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Branch</TableHead>
                <TableHead className="text-right">FAR = FRR</TableHead>
                <TableHead className="text-right">FRR at FAR ≤ {Math.round(budget * 100)}%</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.m} className={r.m === "fused" ? "bg-muted/40 font-medium" : undefined}>
                  <TableCell>
                    {r.m === "fused" ? (
                      "Fused"
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <span className="size-2 rounded-full" style={{ background: modalityColor(r.m) }} />
                        {modalityLabel(r.m, true)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="tnum text-right font-mono text-xs">{pct(r.eer)}</TableCell>
                  <TableCell className="tnum text-right font-mono text-xs">
                    {r.frrAtBudget === null ? <span className="text-muted-foreground">no curve</span> : pct(r.frrAtBudget)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            FAR: a not-A block scored as A. FRR: one of A&apos;s blocks scored as not-A. A single block is weak evidence on purpose; trust accumulates
            many blocks, and behavior alone never blocks anyone.
          </p>
        </>
      ) : (
        <NotMeasured title="No operating points yet">No branch in this report has a ROC curve to read them from.</NotMeasured>
      )}
    </div>
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
      <div className="mt-1 text-muted-foreground">{r.delta > 0 ? "Removing it hurts: this branch carries signal." : r.delta < 0 ? "Removing it helps: this branch adds noise today." : "No change."}</div>
    </TipBox>
  );
}

export function AblationChart({ report, height = 200 }: { report: EvalReport; height?: number }) {
  const measured = new Set(measuredModalities(report));
  const full = report.fused.eer;
  const all = (report.ablation ?? []).filter((a) => a.fused_eer !== null);
  const data: AblRow[] = all
    .filter((a) => measured.has(a.removed))
    .map((a) => ({ label: modalityLabel(a.removed, true), m: a.removed, eer: a.fused_eer as number, delta: (a.fused_eer as number) - (full ?? 0) }));
  const inert = all.filter((a) => !measured.has(a.removed)).map((a) => modalityLabel(a.removed, true).toLowerCase());
  if (full === null || !data.length) {
    return <NotMeasured title="No ablation yet">Ablation needs a fused score and at least one measured branch.</NotMeasured>;
  }
  const max = Math.ceil((Math.max(full, ...data.map((d) => d.eer)) * 1.2) / 0.05) * 0.05 || 0.2;
  const h = Math.max(height, 56 + data.length * 34);
  return (
    <div className="space-y-2">
      <div style={{ height: h }}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 420, height: h }}>
          <BarChart data={data} layout="vertical" margin={{ top: 22, right: 76, bottom: 4, left: 4 }} barCategoryGap={10}>
            <CartesianGrid horizontal={false} stroke="var(--grid)" />
            <XAxis type="number" domain={[0, max]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
            <YAxis type="category" dataKey="label" width={92} tick={{ ...AXIS_TICK, fontSize: 11 }} tickFormatter={(v: string) => `− ${v}`} tickLine={false} axisLine={false} />
            <ReferenceLine x={full} stroke="var(--foreground)" strokeOpacity={0.7} strokeDasharray="4 3" label={{ value: `all branches ${pct(full)}`, position: "top", fill: "var(--foreground)", fontSize: 10 }} />
            <Tooltip content={AblTip} cursor={{ fill: "var(--muted)", fillOpacity: 0.4 }} isAnimationActive={false} />
            <Bar
              dataKey="eer"
              radius={[0, 4, 4, 0]}
              isAnimationActive={false}
              label={{
                position: "right",
                fill: "var(--muted-foreground)",
                fontSize: 10,
                formatter: (v: unknown) => {
                  if (typeof v !== "number") return "";
                  const d = (v - full) * 100;
                  return `${pct(v)} (${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(1)})`;
                },
              }}
            >
              {data.map((d) => (
                <Cell key={d.m} fill={modalityColor(d.m)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Fused EER with one branch removed (points vs all branches in brackets). Higher than the dashed line means that branch carries signal.
        {inert.length > 0 && <> Not shown: {inert.join(", ")} (not in the fused score yet, so removing them changes nothing).</>}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Identification (only when it actually ran) / the one-class explanation
// ---------------------------------------------------------------------------

export function ConfusionMatrix({ report }: { report: EvalReport }) {
  const id = report.identification;
  if (!id) return null;
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
        Who produced this block? Accuracy <b className="tnum text-foreground">{pct(id.accuracy)}</b> over {id.confusion.flat().reduce((a, b) => a + b, 0)} held-out blocks.
        A side experiment: 2bME itself never identifies anyone.
      </p>
    </div>
  );
}

const CHAIN = [
  ["Typicality", "How usual is this block for A's own baseline? No other users' data."],
  ["Evidence", "Each block becomes a small log-likelihood ratio against a fixed not-A model."],
  ["Trust", "Evidence accumulates into P(still A): a calibrated probability, not a feeling."],
] as const;

export function IdentificationCard({ report }: { report: EvalReport }) {
  if (identificationRan(report)) return <ConfusionMatrix report={report} />;
  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed">
        We don&apos;t ask <span className="text-muted-foreground line-through decoration-trust-suspicious/70">who is this?</span> We ask{" "}
        <b>is this still A?</b>
      </p>
      <ol className="space-y-2">
        {CHAIN.map(([k, v], i) => (
          <li key={k} className="flex gap-3">
            <span className="tnum grid size-6 shrink-0 place-items-center rounded-full bg-muted font-mono text-[11px]">{i + 1}</span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              <b className="text-foreground">{k}.</b> {v}
            </span>
          </li>
        ))}
      </ol>
      <p className="border-t pt-3 text-[11px] leading-relaxed text-muted-foreground">
        A which-of-N identification matrix wasn&apos;t run for this report (the teammate has too little data to train a model of their own), and it
        isn&apos;t the claim: verification only needs A&apos;s baseline.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live TTD trials
// ---------------------------------------------------------------------------

export function TtdTrials({ report }: { report: EvalReport }) {
  const trials = report.live_trials ?? [];
  const stats = liveTrialStats(report);
  const detected = trials.filter((t) => t.detected && t.ttd_s !== null).map((t) => t.ttd_s as number);
  const max = Math.max(75, ...detected);
  const slots = Math.max(LIVE_TRIALS_TARGET, trials.length);
  return (
    <div className="space-y-3">
      <div className="flex gap-6">
        <div>
          <div className="eyebrow">recorded</div>
          <div className="tnum text-3xl font-semibold">
            {trials.length}
            <span className="text-lg text-muted-foreground"> of {LIVE_TRIALS_TARGET}</span>
          </div>
        </div>
        <div>
          <div className="eyebrow">median TTD</div>
          <div className="tnum text-3xl font-semibold">{stats.median !== null ? `${Math.round(stats.median)} s` : "—"}</div>
        </div>
        {trials.length > 0 && (
          <div>
            <div className="eyebrow">detected</div>
            <div className="tnum text-3xl font-semibold">
              {stats.detected}/{trials.length}
            </div>
          </div>
        )}
      </div>
      <ol className="space-y-1.5">
        {Array.from({ length: slots }, (_, i) => {
          const t = trials[i];
          if (!t) {
            return (
              <li key={`slot-${i}`} className="grid grid-cols-[4.5rem_1fr_3.5rem] items-center gap-3 text-xs text-muted-foreground">
                <span className="font-mono">trial {i + 1}</span>
                <div className="h-2 rounded-full border border-dashed" />
                <span className="text-right font-mono">—</span>
              </li>
            );
          }
          return (
            <li key={t.t_start + i} className="grid grid-cols-[4.5rem_1fr_3.5rem] items-center gap-3 text-xs">
              <span className="tnum font-mono text-muted-foreground">{fmtClock(t.t_start, false)}</span>
              <div className="relative h-2 rounded-full bg-muted">
                {t.ttd_s !== null && (
                  <div
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{ width: `${Math.min(100, (t.ttd_s / max) * 100)}%`, background: t.detected ? "var(--brand)" : "var(--trust-suspicious)" }}
                  />
                )}
                <div className="absolute inset-y-[-3px] w-px bg-foreground/60" style={{ left: `${(60 / max) * 100}%` }} title="60 s target" />
              </div>
              <span className={cn("tnum flex items-center justify-end gap-1 font-mono", !t.detected && "text-trust-suspicious")}>
                {t.detected ? <CheckCircle2 className="size-3 text-trust-normal" /> : <CircleX className="size-3" />}
                {t.ttd_s !== null ? `${Math.round(t.ttd_s)}s` : "missed"}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {trials.length === 0
          ? `0 of ${LIVE_TRIALS_TARGET} live trials recorded yet. `
          : ""}
        A trial starts when the observer presses Mark takeover and a teammate takes the keyboard; it ends at the second tick in a row below{" "}
        {Math.round(ALERT_THRESHOLD * 100)}%. {trials.length > 0 && "The vertical tick marks the 60 s target."}
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
// Honesty panel
// ---------------------------------------------------------------------------

const KIND_COPY: Record<ReturnType<typeof dataKind>, { title: string; body: string; color: string }> = {
  real: { title: "Real recordings", body: "The report says no synthetic data was used.", color: "var(--trust-normal)" },
  synthetic: { title: "Synthetic data only", body: "This run validates the pipeline, not real-person performance.", color: "var(--trust-watch)" },
  sample: { title: "SAMPLE fixture", body: "Made-up numbers for UI development. Not a result.", color: "var(--trust-watch)" },
  unknown: { title: "Provenance not stated", body: "The report doesn't say whether its data is real.", color: "var(--muted-foreground)" },
};

export function HonestyPanel({ report }: { report: EvalReport }) {
  const kind = dataKind(report);
  const copy = KIND_COPY[kind];
  const recs = recordingCounts(report);
  const disabled = disabledReasons(report.notes);
  const split = splitInfo(report);
  const measured = measuredModalities(report);
  const chance = measured.filter((m) => (report.modalities[m]?.auc ?? 1) < 0.6);
  const trials = liveTrialStats(report);
  const nb = report.n_blocks;
  const reuse = impostorReuse(report);
  const tuning = [
    reuse.betaFitted.length > 0 &&
      `set how much ${reuse.betaFitted.map((m) => modalityLabel(m, true).toLowerCase()).join(" and ")} evidence counts (β)`,
    reuse.modelSelection && "were used to choose the detector",
  ].filter((x): x is string => !!x);

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-3">
        <h3 className="eyebrow">The data</h3>
        <div className="flex items-start gap-2.5">
          <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: copy.color }} />
          <div>
            <div className="text-sm font-medium">{copy.title}</div>
            <div className="text-xs text-muted-foreground">{copy.body}</div>
          </div>
        </div>
        <ul className="space-y-1.5 text-xs text-muted-foreground">
          <li>
            <b className="text-foreground">Teammates only.</b> A is the enrolled owner, not-A is one teammate. No volunteers, no public datasets.
          </li>
          {recs && (
            <li>
              <b className="text-foreground">
                {recs.a} recording{recs.a === 1 ? "" : "s"} of A, {recs.b} of not-A.
              </b>{" "}
              Small-sample development evidence.
            </li>
          )}
          <li className="tnum font-mono">
            {["a", "b"].map((who) => (
              <div key={who}>
                {who === "a" ? "A    " : "not-A"}{" "}
                {Object.keys(nb[who] ?? {}).length
                  ? Object.entries(nb[who] ?? {})
                      .map(([m, n]) => `${modalityLabel(m, true).toLowerCase()} ${n}`)
                      .join(" · ")
                  : "no blocks"}
              </div>
            ))}
          </li>
        </ul>
      </div>

      <div className="space-y-3">
        <h3 className="eyebrow">How it was scored</h3>
        <ul className="space-y-1.5 text-xs leading-relaxed text-muted-foreground">
          <li>
            <b className="text-foreground">One-class.</b> The model is trained on A only. Not-A&apos;s blocks never enter its training data.
          </li>
          {tuning.length > 0 && (
            <li>
              <b className="text-foreground">Not a blind test.</b> Not-A&apos;s blocks also {tuning.join(" and ")}, so these EERs are optimistic.
            </li>
          )}
          <li>
            <b className="text-foreground">Chronological split.</b> A&apos;s later blocks are the test set
            {split?.purge_s ? `, with a ${split.purge_s} s purge between train and test` : ""}, so the model never sees its own test window.
          </li>
          <li>
            <b className="text-foreground">Offline.</b> The fused ROC is a weighted summary over 60 s windows, not the live trust engine or checkout
            accuracy.
          </li>
        </ul>
      </div>

      <div className="space-y-3">
        <h3 className="eyebrow">What it doesn&apos;t show yet</h3>
        <ul className="space-y-1.5 text-xs leading-relaxed text-muted-foreground">
          {Object.entries(disabled).map(([m, why]) => (
            <li key={m}>
              <b className="text-foreground">{modalityLabel(m, true)}:</b> not measured ({why.toLowerCase()}).
            </li>
          ))}
          {chance.map((m) => (
            <li key={m}>
              <b className="text-foreground">{modalityLabel(m, true)}:</b> near chance (AUC {num(report.modalities[m]?.auc)}) on this data.
            </li>
          ))}
          {!report.splice && (
            <li>
              <b className="text-foreground">FAR/FRR at the {Math.round(ALERT_THRESHOLD * 100)}% cut:</b> needs the splice replay (trust over time). The
              FAR/FRR panel shows block-level ROC points instead.
            </li>
          )}
          {trials.n < LIVE_TRIALS_TARGET && (
            <li>
              <b className="text-foreground">Live trials:</b> {trials.n} of {LIVE_TRIALS_TARGET} marked takeovers recorded.
            </li>
          )}
          {!identificationRan(report) && (
            <li>
              <b className="text-foreground">Identification:</b> not run; not-A has too little data for a model of their own.
            </li>
          )}
          {kind === "real" && (
            <li>
              The synthetic end-to-end test separates people by construction, so its numbers are never quoted here.
            </li>
          )}
          {kind === "sample" && <li>Everything: this is a sample fixture, not a measurement.</li>}
        </ul>
      </div>

      {report.notes.length > 0 && (
        <details className="group lg:col-span-3">
          <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">
            Report notes, verbatim ({report.notes.length})
          </summary>
          <ul className="mt-2 space-y-1 border-l pl-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {report.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Amber banner for sample fixtures (?mock=1): impossible to mistake for results. */
export function SampleBanner() {
  return (
    <div className="mb-6 flex items-center gap-3 rounded-xl border border-trust-watch/45 bg-trust-watch/10 px-4 py-3 text-sm">
      <FlaskConical className="size-4 shrink-0 text-trust-watch" />
      <span>
        <b className="font-semibold tracking-wide">SAMPLE.</b> Every number on this page is a made-up fixture for UI development, not a measurement.{" "}
        <a href="/lab?mock=0" className="underline underline-offset-4">
          Show the real report
        </a>
      </span>
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
    <span className={cn("tnum inline-flex items-center justify-end gap-1.5 font-mono text-xs", strong && "font-semibold")}>
      <span className="size-1.5 rounded-full" style={{ background: color }} />
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
