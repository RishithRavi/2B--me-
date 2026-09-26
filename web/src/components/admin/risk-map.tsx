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

function Cell({ row, selected, onSelect }: { row: RosterRow; selected: boolean; onSelect: () => void }) {
  const color = levelColor(row.level);
  const hot = row.level === "suspicious" || row.level === "locked";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onSelect}
          aria-label={`${row.handle}: ${row.locked ? "locked" : `${row.display ?? "—"}% ${levelLabel(row.level)}`}`}
          className={cn(
            "relative flex h-12 w-[52px] shrink-0 flex-col items-center justify-center rounded-md transition-transform outline-none hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring",
            selected && "ring-2 ring-foreground",
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
    const team = r.synthetic ? (r.team ?? "Unassigned") : "Enrolled owner";
    const list = teams.get(team) ?? [];
    list.push(r);
    teams.set(team, list);
  }
  const groups = Array.from(teams.entries()).map(([team, list]) => ({
    team,
    list: list.slice().sort((a, b) => a.handle.localeCompare(b.handle, undefined, { numeric: true })),
    risk: list.filter((r) => r.locked || r.level === "suspicious" || r.level === "watch").length,
  }));

  return (
    <Panel
      title="Org risk map"
      icon={Radar}
      hint="every employee by team · click to drill in"
      action={
        <div className="hidden items-center gap-3 md:flex">
          {LEGEND.map((l) => (
            <span key={l.level} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="size-2 rounded-sm" style={{ background: levelColor(l.level) }} />
              {levelLabel(l.level)} <span className="text-muted-foreground/60">{l.text}</span>
            </span>
          ))}
        </div>
      }
    >
      <div className="flex flex-wrap gap-2.5">
        {groups.map((g) => (
          <div key={g.team} className="rounded-lg bg-muted/35 p-2 ring-1 ring-foreground/5">
            <div className="mb-1.5 flex items-center justify-between gap-3 px-0.5">
              <span className="text-[11.5px] font-medium">{g.team}</span>
              <span className={cn("tnum text-[10.5px]", g.risk ? "text-trust-watch" : "text-muted-foreground")}>
                {g.list.length}
                {g.risk ? ` · ${g.risk} at risk` : ""}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
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
