"use client";

import { AudioLines, Lock, ShieldAlert, Siren, Wifi, type LucideIcon } from "lucide-react";
import { motion } from "framer-motion";

import type { OrgKpis } from "@/lib/org-live";
import { cn } from "@/lib/utils";

function Tile({
  label,
  short,
  value,
  of,
  sub,
  icon: Icon,
  color,
  hot,
}: {
  label: string;
  short: string;
  value: number;
  of?: number;
  sub: string;
  icon: LucideIcon;
  color: string;
  hot: boolean;
}) {
  return (
    <div
      className={cn("panel relative overflow-hidden px-4 pt-3.5 pb-3 transition-shadow last:col-span-2 sm:last:col-span-1", hot && "ring-1")}
      style={hot ? { boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${color} 40%, transparent)`, background: `linear-gradient(180deg, color-mix(in oklch, ${color} 9%, var(--card)) 0%, var(--card) 70%)` } : undefined}
    >
      {hot && <span className="absolute inset-x-0 top-0 h-0.5" style={{ background: color }} />}
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow truncate">
          <span className="sm:hidden">{short}</span>
          <span className="hidden sm:inline">{label}</span>
        </span>
        <span
          className="grid size-7 shrink-0 place-items-center rounded-lg"
          style={{ color: hot ? color : "var(--muted-foreground)", background: hot ? `color-mix(in oklch, ${color} 15%, transparent)` : "var(--muted)" }}
        >
          <Icon className="size-3.5" />
        </span>
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <motion.span
          key={value}
          initial={{ opacity: 0.4, y: -3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="tnum text-3xl font-semibold tracking-tight"
          style={{ color: hot ? color : undefined }}
        >
          {value}
        </motion.span>
        {of !== undefined && <span className="tnum text-sm text-muted-foreground">/ {of}</span>}
      </div>
      <div className="mt-0.5 text-xs leading-snug text-muted-foreground sm:truncate">{sub}</div>
    </div>
  );
}

export function KpiStrip({ kpis, loading }: { kpis: OrgKpis; loading?: boolean }) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="panel h-[104px] animate-pulse" />
        ))}
      </div>
    );
  }
  const offline = kpis.total - kpis.online;
  const none = kpis.total === 0;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <Tile
        label="Employees online"
        short="Online"
        value={kpis.online}
        of={kpis.total}
        sub={none ? "no devices on the roster" : offline ? `${offline} offline · heartbeat > 30 s` : "every device reporting"}
        icon={Wifi}
        color="var(--trust-normal)"
        hot={false}
      />
      <Tile
        label="At risk"
        short="At risk"
        value={kpis.atRisk}
        sub={none ? "no trust data yet" : kpis.atRisk ? `${kpis.suspicious} suspicious · ${kpis.watch} watch` : "everyone above 80%"}
        icon={ShieldAlert}
        color={kpis.suspicious ? "var(--trust-suspicious)" : "var(--trust-watch)"}
        hot={kpis.atRisk > 0}
      />
      <Tile
        label="Locked"
        short="Locked"
        value={kpis.locked}
        sub={kpis.locked ? "voice block or admin lock" : "no locked devices"}
        icon={Lock}
        color="var(--trust-locked)"
        hot={kpis.locked > 0}
      />
      <Tile
        label="Open challenges"
        short="Challenges"
        value={kpis.openChallenges}
        sub={kpis.openChallenges ? "voice / MFA step-up pending" : "none pending"}
        icon={AudioLines}
        color="var(--trust-watch)"
        hot={kpis.openChallenges > 0}
      />
      <Tile
        label="Alerts · last hour"
        short="Alerts · 1 h"
        value={kpis.alertsLastHour}
        sub="severity ≥ 3 in the audit trail"
        icon={Siren}
        color="var(--trust-suspicious)"
        hot={kpis.alertsLastHour > 0}
      />
    </div>
  );
}
