"use client";

// Roster: one row per device (table layout on desktop, cards on phones), sorted by risk by default.
import { AnimatePresence, motion } from "framer-motion";
import { Users } from "lucide-react";

import { Panel } from "@/components/site/panel";
import type { RosterRow } from "@/lib/contracts";
import type { RosterSort } from "@/lib/org-live";
import { fmtAgo, levelColor } from "@/lib/ui";
import { cn } from "@/lib/utils";

import { EmployeeAvatar, FlagChips, OrgSpark, SyntheticTag, TrustFigure } from "./org-bits";

const COLS = "lg:grid-cols-[minmax(0,1.45fr)_minmax(0,0.85fr)_minmax(0,1fr)_minmax(0,1.35fr)_88px]";

function accent(row: RosterRow): string | null {
  if (row.locked || row.level === "suspicious" || row.level === "watch") return levelColor(row.level);
  return null;
}

function Row({ row, lastAlert, now, selected, onSelect }: { row: RosterRow; lastAlert: string | null; now: number; selected: boolean; onSelect: () => void }) {
  const bar = accent(row);
  const hot = row.locked || row.level === "suspicious";
  return (
    <motion.button
      layout="position"
      transition={{ type: "spring", stiffness: 420, damping: 38 }}
      type="button"
      onClick={onSelect}
      className={cn(
        "group relative grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-lg px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        COLS,
        "hover:bg-muted/45",
        selected && "bg-muted/60 ring-1 ring-foreground/15",
      )}
      style={hot ? { background: `color-mix(in oklch, ${levelColor(row.level)} 7%, transparent)` } : undefined}
    >
      {bar && <span className="absolute inset-y-2 left-0 w-[3px] rounded-full" style={{ background: bar }} />}

      {/* Employee */}
      <div className="flex min-w-0 items-center gap-3">
        <EmployeeAvatar row={row} />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium">{row.handle}</span>
            <SyntheticTag synthetic={row.synthetic} compact />
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <span className="truncate">{row.team ?? "—"}</span>
            <span className="text-muted-foreground/50">·</span>
            <span className="truncate font-mono text-[10.5px]">{row.device_label}</span>
          </div>
        </div>
      </div>

      {/* Trust */}
      <div className="flex flex-col items-end gap-0.5 justify-self-end lg:items-start lg:justify-self-start">
        <div className={cn(!row.online && "opacity-55")}>
          <TrustFigure row={row} />
        </div>
        {!row.online && (
          <span className="rounded bg-muted px-1 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
            offline · last {row.last_seen ? fmtAgo(row.last_seen, now).replace(" ago", "") : "—"}
          </span>
        )}
      </div>

      {/* 5-min trend */}
      <div className="col-span-2 lg:col-span-1">
        <OrgSpark values={row.sparkline} level={row.level} dim={!row.online} height={30} />
      </div>

      {/* Flags */}
      <div className="col-span-2 min-w-0 lg:col-span-1">
        <FlagChips flags={row.flags} />
      </div>

      {/* Last alert */}
      <div className="hidden text-right text-[11.5px] text-muted-foreground lg:block">
        {lastAlert ? <span className="tnum">{fmtAgo(lastAlert, now)}</span> : <span className="text-muted-foreground/60">—</span>}
      </div>
    </motion.button>
  );
}

export function Roster({
  rows,
  lastAlertBy,
  now,
  selectedId,
  onSelect,
  sort,
  onSort,
  loading,
  empty,
}: {
  rows: RosterRow[];
  lastAlertBy: ReadonlyMap<string, string>;
  now: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  sort: RosterSort;
  onSort: (s: RosterSort) => void;
  loading?: boolean;
  empty?: React.ReactNode;
}) {
  return (
    <Panel
      title="Roster"
      icon={Users}
      hint={`${rows.length} device${rows.length === 1 ? "" : "s"} · ${sort === "risk" ? "riskiest first" : "A–Z"}`}
      action={
        <div className="inline-flex rounded-lg bg-muted p-0.5 text-[11.5px]" role="group" aria-label="Sort roster">
          {(["risk", "name"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSort(s)}
              className={cn(
                "rounded-md px-2 py-0.5 font-medium text-muted-foreground transition-colors",
                sort === s && "bg-card text-foreground shadow-sm ring-1 ring-foreground/10",
              )}
            >
              {s === "risk" ? "Risk" : "A–Z"}
            </button>
          ))}
        </div>
      }
      bodyClassName="px-2 pb-2"
    >
      <div className={cn("hidden gap-x-4 px-3 pt-1 pb-2 lg:grid", COLS)}>
        {["Employee", "Trust", "Last 5 min", "Flags", "Last alert"].map((h, i) => (
          <span key={h} className={cn("eyebrow text-[10px] whitespace-nowrap", i === 4 && "text-right")}>
            {h}
          </span>
        ))}
      </div>
      {loading ? (
        <div className="space-y-1.5 px-1">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/50" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        empty
      ) : (
        <div className="divide-y divide-border/60 lg:divide-y-0">
          <AnimatePresence initial={false}>
            {rows.map((r) => (
              <Row key={r.device_id} row={r} lastAlert={lastAlertBy.get(r.device_id) ?? null} now={now} selected={r.device_id === selectedId} onSelect={() => onSelect(r.device_id)} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </Panel>
  );
}
