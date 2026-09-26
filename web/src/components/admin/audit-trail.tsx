"use client";

// Org audit trail (newGoal: "an audit of trust-score changes, alerts, challenges and administration actions").
// Filter by kind and employee; with one employee selected it becomes the breach trace-back view.
import { Download, ExternalLink, History, Route, ScrollText, X } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";

import { Panel } from "@/components/site/panel";
import { Button } from "@/components/ui/button";
import type { AuditKind, AuditRow, RosterRow } from "@/lib/contracts";
import { AUDIT_KINDS, auditCsv, auditKindLabel } from "@/lib/org-live";
import { fmtAgo, fmtClock } from "@/lib/ui";
import { cn } from "@/lib/utils";

import { KIND_META, KindChip, SeverityMeter, severityColor } from "./org-bits";

const COLS = "lg:grid-cols-[76px_minmax(0,120px)_minmax(0,128px)_minmax(0,110px)_minmax(0,1fr)_92px]";

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

export function AuditTrail({
  audit,
  rows,
  filter,
  onFilter,
  onSelect,
  now,
}: {
  audit: AuditRow[];
  rows: readonly RosterRow[];
  filter: AuditFilter;
  onFilter: (f: AuditFilter) => void;
  onSelect: (deviceId: string) => void;
  now: number;
}) {
  const byDevice = useMemo(() => (filter.device === "all" ? audit : audit.filter((r) => r.device_id === filter.device)), [audit, filter.device]);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of byDevice) c.set(r.kind, (c.get(r.kind) ?? 0) + 1);
    return c;
  }, [byDevice]);
  const shown = filter.kind === "all" ? byDevice : byDevice.filter((r) => r.kind === filter.kind);
  const employees = useMemo(
    () => rows.slice().sort((a, b) => a.handle.localeCompare(b.handle, undefined, { numeric: true })),
    [rows],
  );
  const traced = filter.device !== "all" ? rows.find((r) => r.device_id === filter.device) ?? null : null;
  const first = byDevice.length ? byDevice[byDevice.length - 1] : null;
  const alerts = byDevice.filter((r) => r.severity >= 3).length;
  const dashHref = traced ? `/dashboard?device_id=${encodeURIComponent(traced.device_id)}` : "/dashboard";

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
            const n = k === "all" ? byDevice.length : (counts.get(k) ?? 0);
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
        <div className="flex items-center gap-2 lg:ml-auto">
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
          <Route className="size-4 shrink-0 text-brand-2" />
          <div className="min-w-0 flex-1 text-[13px]">
            <span className="font-medium">Trace-back · {traced.handle}</span>
            <span className="text-muted-foreground">
              {" "}
              · {byDevice.length} event{byDevice.length === 1 ? "" : "s"}
              {first ? ` since ${fmtClock(first.t)}` : ""} · {alerts} alert{alerts === 1 ? "" : "s"}
            </span>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button asChild variant="outline" size="xs">
              <Link href={dashHref}>
                <ExternalLink /> Live dashboard
              </Link>
            </Button>
            <Button asChild variant="outline" size="xs">
              <Link href="/history">
                <History /> History
              </Link>
            </Button>
          </div>
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
            {shown.slice(0, 250).map((r) => (
              <li
                key={r.id}
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
                <span className="order-4 col-span-2 truncate text-[12px] text-muted-foreground lg:order-none lg:col-span-1">
                  <span className="lg:hidden">by </span>
                  {r.actor}
                </span>
                <span className="order-3 col-span-3 text-[13px] leading-snug lg:order-none lg:col-span-1">{r.summary}</span>
                <span className="order-5 justify-self-end lg:order-none lg:justify-self-start">
                  <SeverityMeter severity={r.severity} />
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Panel>
  );
}
