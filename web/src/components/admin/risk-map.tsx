"use client";

// Org risk map: every employee as one cell, grouped by team, colored by trust level. The at-a-glance
// "who's drifting, who's mid-challenge, who got locked" view (§2.4).
import { Lock, Radar } from "lucide-react";

import { Panel } from "@/components/site/panel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Level, RosterRow } from "@/lib/contracts";
import { flagLabel } from "@/lib/org-live";
import { levelColor, levelLabel } from "@/lib/ui";
import { cn } from "@/lib/utils";

import { handleShort } from "./org-bits";

const LEGEND: { level: Level; text: string }[] = [
  { level: "normal", text: "≥ 80%" },
  { level: "watch", text: "40–79%" },
  { level: "suspicious", text: "< 40%" },
  { level: "locked", text: "voice / admin" },
  { level: "learning", text: "enrolling" },
];

const OWNER_TEAM = "Enrolled owner";

function Legend({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-x-3", className)}>
      {LEGEND.map((l) => (
        <span key={l.level} className="inline-flex items-center gap-1.5 text-[11px] whitespace-nowrap text-muted-foreground">
          <span className="size-2 rounded-sm" style={{ background: levelColor(l.level) }} />
          {levelLabel(l.level)} <span className="hidden text-muted-foreground md:inline">{l.text}</span>
        </span>
      ))}
    </div>
  );
}

function Cell({ row, selected, onSelect }: { row: RosterRow; selected: boolean; onSelect: () => void }) {
  const color = levelColor(row.level);
  const hot = row.level === "suspicious" || row.level === "locked";
  // Focus and selection use outline, not ring: the inline inset boxShadow below overrides a ring's box-shadow.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onSelect}
          aria-label={`${row.handle}: ${row.locked ? "locked" : `${row.display ?? "—"}% ${levelLabel(row.level)}`}`}
          className={cn(
            "relative flex h-12 w-11 shrink-0 flex-col items-center justify-center rounded-md transition-transform hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            selected && "outline-2 outline-offset-2 outline-foreground",
            !row.online && "opacity-40",
          )}
          style={{
            background: `color-mix(in oklch, ${color} ${hot ? 26 : 15}%, var(--card))`,
            boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${color} ${row.online ? 45 : 25}%, transparent)`,
          }}
        >
          {hot && <span className="absolute inset-0 animate-pulse rounded-md" style={{ boxShadow: `0 0 12px 0 color-mix(in oklch, ${color} 55%, transparent)` }} />}
          <span className="font-mono text-[10px] leading-none text-muted-foreground">{handleShort(row.handle)}</span>
          <span className="tnum mt-1 text-[13px] leading-none font-semibold" style={{ color }}>
            {row.locked ? <Lock className="size-3.5" /> : row.level === "learning" ? "—" : `${row.display ?? "—"}`}
          </span>
          {row.flags.length > 0 && !row.locked && (
            <span className="absolute top-1 right-1 size-1.5 rounded-full" style={{ background: row.flags.includes("takeover_suspected") ? "var(--trust-suspicious)" : "var(--trust-watch)" }} />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="flex-col items-start gap-0.5">
        <span className="font-medium">
          {row.handle} · {row.locked ? "Locked" : row.level === "learning" ? "Learning" : `${row.display}% ${levelLabel(row.level)}`}
        </span>
        <span className="opacity-75">
          {row.device_label}
          {row.online ? "" : " · offline"}
          {row.flags.length ? ` · ${row.flags.map(flagLabel).join(", ")}` : ""}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

export function RiskMap({
  rows,
  selectedId,
  onSelect,
}: {
  rows: readonly RosterRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const teams = new Map<string, RosterRow[]>();
  for (const r of rows) {
    const team = r.synthetic ? (r.team ?? "Unassigned") : OWNER_TEAM;
    const list = teams.get(team) ?? [];
    list.push(r);
    teams.set(team, list);
  }
  // A fixed order (owner first, then teams A→Z): Map insertion order follows the roster, which the 30 s re-sync reshuffles.
  const groups = Array.from(teams.entries())
    .map(([team, list]) => ({
      team,
      list: list.slice().sort((a, b) => a.handle.localeCompare(b.handle, undefined, { numeric: true })),
      // Same definition as the "At risk" KPI (orgKpis): watch + suspicious; locked is counted on its own.
      risk: list.filter((r) => !r.locked && (r.level === "suspicious" || r.level === "watch")).length,
      locked: list.filter((r) => r.locked).length,
    }))
    .sort((a, b) => (a.team === OWNER_TEAM ? -1 : b.team === OWNER_TEAM ? 1 : a.team.localeCompare(b.team)));

  return (
    <Panel
      title="Org risk map"
      icon={Radar}
      hint="every employee by team · click to drill in"
      action={<Legend className="hidden lg:flex" />}
    >
      {/* Below lg the header has no room: the legend gets its own row above the grid. */}
      <Legend className="mb-2.5 flex-wrap gap-y-1 lg:hidden" />
      {/* 156px = three 44px cells + gaps + padding: the live org's 8 groups fit one row at 1440 (auto-fit stretches fewer). */}
      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(156px,1fr))]">
        {groups.map((g) => (
          <div key={g.team} className="rounded-lg bg-muted/35 p-2 ring-1 ring-foreground/5">
            <div className="mb-1.5 flex items-center justify-between gap-3 px-0.5">
              <span className="truncate text-[11.5px] font-medium">{g.team}</span>
              <span className={cn("tnum shrink-0 text-[10.5px]", g.risk ? "text-trust-watch" : g.locked ? "text-trust-locked" : "text-muted-foreground")}>
                {g.list.length}
                {g.risk ? ` · ${g.risk} at risk` : ""}
                {g.locked ? ` · ${g.locked} locked` : ""}
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {g.list.map((r) => (
                <Cell key={r.device_id} row={r} selected={r.device_id === selectedId} onSelect={() => onSelect(r.device_id)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
