"use client";

// Org audit trail (newGoal: "an audit of trust-score changes, alerts, challenges and administration actions").
// Filter by kind and employee; with one employee selected it becomes the breach trace-back view.
import { Download, ExternalLink, History, RotateCcw, Route, ScrollText, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { Panel } from "@/components/site/panel";
import { Button } from "@/components/ui/button";
import type { AuditKind, AuditRow, RosterRow } from "@/lib/contracts";
import { AUDIT_KINDS, auditCsv, auditKindLabel, engineRestarts, isEngineRow, type EngineRestart } from "@/lib/org-live";
import { fmtAgo, fmtClock } from "@/lib/ui";
import { cn } from "@/lib/utils";

import { KIND_META, KindChip, SeverityMeter, severityColor } from "./org-bits";

const COLS = "lg:grid-cols-[76px_minmax(0,120px)_minmax(0,128px)_minmax(0,110px)_minmax(0,1fr)_92px]";
const MAX_ROWS = 250;

export interface AuditFilter {
  kind: AuditKind | "all";
  device: string | "all";
}

function download(name: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type TrailItem = { row: AuditRow } | { restart: EngineRestart };

/**
 * Interleave the engine's restart lines with the rows by time (both newest first). When the list is cut at MAX_ROWS,
 * restarts older than the last row shown are left out rather than dangling below it.
 */
function withRestarts(rows: readonly AuditRow[], restarts: readonly EngineRestart[], truncated: boolean): TrailItem[] {
  const t = (iso: string) => Date.parse(iso) || 0;
  const floor = truncated && rows.length ? t(rows[rows.length - 1].t) : -Infinity;
  const out: TrailItem[] = [];
  let i = 0;
  for (const restart of restarts) {
    const rt = t(restart.t);
    if (rt < floor) break;
    while (i < rows.length && t(rows[i].t) >= rt) out.push({ row: rows[i++] });
    out.push({ restart });
  }
  while (i < rows.length) out.push({ row: rows[i++] });
  return out;
}

function RestartLine({ restart }: { restart: EngineRestart }) {
  return (
    <li className="flex items-center gap-2 bg-muted/25 px-3 py-1.5 text-[12px] text-muted-foreground" title={`${restart.rows} engine row${restart.rows === 1 ? "" : "s"} hidden`}>
      <RotateCcw className="size-3 shrink-0" />
      <span>Synthetic scenario restarted at {fmtClock(restart.t, false)} (demo engine, not an authentication)</span>
    </li>
  );
}

function AuditLine({ r, now, onSelect }: { r: AuditRow; now: number; onSelect: (deviceId: string) => void }) {
  return (
    <li
      className={cn(
        "relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-3 py-2 text-[13px]",
        COLS,
        "lg:items-center",
        r.severity >= 5 && "bg-trust-locked/7",
        r.severity === 3 || r.severity === 4 ? "bg-trust-suspicious/5" : "",
      )}
    >
      {r.severity >= 3 && <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full" style={{ background: severityColor(r.severity) }} />}
      <time className="tnum font-mono text-[11.5px] text-muted-foreground" title={fmtAgo(r.t, now)}>
        {fmtClock(r.t)}
      </time>
      <span className="min-w-0 truncate">
        {r.device_id ? (
          <button type="button" onClick={() => r.device_id && onSelect(r.device_id)} className="truncate font-medium hover:underline">
            {r.handle ?? r.device_id.slice(0, 8)}
          </button>
        ) : (
          <span className="text-muted-foreground">Org</span>
        )}
      </span>
      <span className="justify-self-end lg:justify-self-start">
        <KindChip kind={r.kind} />
      </span>
      <span className="order-4 col-span-2 truncate text-[12px] text-muted-foreground lg:order-none lg:col-span-1" title={r.actor}>
        <span className="lg:hidden">by </span>
        {r.actor}
      </span>
      <span className="order-3 col-span-3 text-[13px] leading-snug lg:order-none lg:col-span-1">{r.summary}</span>
      <span className="order-5 justify-self-end lg:order-none lg:justify-self-start">
        <SeverityMeter severity={r.severity} />
      </span>
    </li>
  );
}

export function AuditTrail({
  audit,
  rows,
  filter,
  onFilter,
  onSelect,
  now,
  mock = false,
}: {
  audit: AuditRow[];
  rows: readonly RosterRow[];
  filter: AuditFilter;
  onFilter: (f: AuditFilter) => void;
  onSelect: (deviceId: string) => void;
  now: number;
  /** the demo org: its devices have no live dashboard or history */
  mock?: boolean;
}) {
  const [showEngine, setShowEngine] = useState(false);
  const byDevice = useMemo(() => (filter.device === "all" ? audit : audit.filter((r) => r.device_id === filter.device)), [audit, filter.device]);
  // The org-demo engine's loop resets are hidden by default and folded into one "scenario restarted" line each.
  const engineN = useMemo(() => byDevice.filter(isEngineRow).length, [byDevice]);
  const visible = useMemo(() => (showEngine ? byDevice : byDevice.filter((r) => !isEngineRow(r))), [byDevice, showEngine]);
  const restarts = useMemo(() => (showEngine ? [] : engineRestarts(byDevice)), [byDevice, showEngine]);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of visible) c.set(r.kind, (c.get(r.kind) ?? 0) + 1);
    return c;
  }, [visible]);
  const shown = filter.kind === "all" ? visible : visible.filter((r) => r.kind === filter.kind);
  const employees = useMemo(
    () => rows.slice().sort((a, b) => a.handle.localeCompare(b.handle, undefined, { numeric: true })),
    [rows],
  );
  const traced = filter.device !== "all" ? rows.find((r) => r.device_id === filter.device) ?? null : null;
  const first = visible.length ? visible[visible.length - 1] : null;
  const alerts = byDevice.filter((r) => r.kind === "alert").length; // same rows as the Alert filter chip
  const dashHref = traced ? `/dashboard?device_id=${encodeURIComponent(traced.device_id)}` : "/dashboard";
  const historyHref = traced ? `/history?device_id=${encodeURIComponent(traced.device_id)}` : "/history";

  return (
    <Panel
      title="Audit trail"
      icon={ScrollText}
      hint="trust changes, alerts, challenges, decisions and admin actions · newest first"
      action={
        <Button
          variant="outline"
          size="xs"
          disabled={!shown.length}
          onClick={() => download(`2bme-audit${traced ? `-${traced.handle.replace(/\s+/g, "").toLowerCase()}` : ""}.csv`, auditCsv(shown))}
        >
          <Download /> CSV
        </Button>
      }
      bodyClassName="space-y-3"
    >
      {/* Filters */}
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5">
          {(["all", ...AUDIT_KINDS] as const).map((k) => {
            const active = filter.kind === k;
            const n = k === "all" ? visible.length : (counts.get(k) ?? 0);
            const color = k === "all" ? "var(--foreground)" : KIND_META[k].color;
            return (
              <button
                key={k}
                type="button"
                onClick={() => onFilter({ ...filter, kind: k })}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground ring-1 ring-foreground/10 transition-colors hover:text-foreground",
                  active && "text-foreground",
                )}
                style={active ? { background: `color-mix(in oklch, ${color} 14%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${color} 40%, transparent)` } : undefined}
              >
                {k === "all" ? "All" : auditKindLabel(k)}
                <span className="tnum text-[10.5px] text-muted-foreground">{n}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto lg:flex-nowrap">
          {engineN > 0 && (
            <button
              type="button"
              aria-pressed={showEngine}
              onClick={() => setShowEngine((v) => !v)}
              title="Rows the org-demo engine writes when it restarts the synthetic scenario (not authentications)"
              className={cn(
                "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground ring-1 ring-foreground/10 transition-colors hover:text-foreground",
                showEngine && "bg-muted text-foreground ring-foreground/25",
              )}
            >
              <RotateCcw className="size-3" /> Show engine rows <span className="tnum text-[10.5px] text-muted-foreground">({engineN})</span>
            </button>
          )}
          <label className="sr-only" htmlFor="audit-employee">
            Employee
          </label>
          <select
            id="audit-employee"
            value={filter.device}
            onChange={(e) => onFilter({ ...filter, device: e.target.value })}
            className="h-7 min-w-44 rounded-lg border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/30"
          >
            <option value="all">All employees</option>
            {employees.map((r) => (
              <option key={r.device_id} value={r.device_id}>
                {r.handle} · {r.team ?? r.device_label}
              </option>
            ))}
          </select>
          {(filter.kind !== "all" || filter.device !== "all") && (
            <Button variant="ghost" size="xs" onClick={() => onFilter({ kind: "all", device: "all" })}>
              <X /> Clear
            </Button>
          )}
        </div>
      </div>

      {/* Trace-back header */}
      {traced && (
        <div className="flex flex-col gap-2 rounded-lg bg-brand-2/8 px-3 py-2.5 ring-1 ring-brand-2/25 sm:flex-row sm:items-center">
          <Route className="hidden size-4 shrink-0 text-brand-2 sm:block" />
          <div className="min-w-0 flex-1 text-[13px]">
            <span className="font-medium">Trace-back · {traced.handle}</span>
            <span className="text-muted-foreground">
              {" "}
              · {visible.length} event{visible.length === 1 ? "" : "s"}
              {first ? ` since ${fmtClock(first.t)}` : ""} · {alerts} alert{alerts === 1 ? "" : "s"}
            </span>
          </div>
          {!mock && (
            <div className="flex shrink-0 gap-1.5">
              <Button asChild variant="outline" size="xs">
                <Link href={dashHref}>
                  <ExternalLink /> Live dashboard
                </Link>
              </Button>
              <Button asChild variant="outline" size="xs">
                <Link href={historyHref}>
                  <History /> History
                </Link>
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-lg ring-1 ring-foreground/8">
        <div className={cn("hidden gap-x-3 bg-muted/40 px-3 py-2 lg:grid", COLS)}>
          {["Time", "Employee", "Kind", "Actor", "Summary", "Severity"].map((h) => (
            <span key={h} className="eyebrow text-[10px]">
              {h}
            </span>
          ))}
        </div>
        {shown.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">No audit rows match this filter.</p>
        ) : (
          <ol className="scrollbar-thin max-h-[520px] divide-y divide-border/60 overflow-y-auto">
            {withRestarts(shown.slice(0, MAX_ROWS), restarts, shown.length > MAX_ROWS).map((item) =>
              "restart" in item ? (
                <RestartLine key={item.restart.id} restart={item.restart} />
              ) : (
                <AuditLine key={item.row.id} r={item.row} now={now} onSelect={onSelect} />
              ),
            )}
          </ol>
        )}
      </div>
    </Panel>
  );
}
