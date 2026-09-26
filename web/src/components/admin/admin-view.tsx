"use client";

// Admin/org control panel (§2.4, IMPLEMENTATION.md, PROPOSED). A roster of synthetic, anonymized employee
// sessions plus an org-wide audit trail — the .tech site's job once the overlay is the per-person product.
// Every card here is fabricated client-side (see lib/admin-mock.ts); nothing is a real employee or a real device.
import { AlertTriangle, Building2, Lock, RefreshCw, ShieldAlert, Users } from "lucide-react";
import { useMemo, useState } from "react";

import { EventFeed } from "@/components/dashboard/event-feed";
import { ModalityBars } from "@/components/dashboard/modality-bars";
import { TrustGauge } from "@/components/dashboard/trust-gauge";
import { WhyChips } from "@/components/dashboard/why-chips";
import { Panel } from "@/components/site/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { generateRoster, type SyntheticEmployee } from "@/lib/admin-mock";
import type { FeedItem } from "@/lib/contracts";
import { fmtAgo, levelColor, levelLabel } from "@/lib/ui";
import { cn } from "@/lib/utils";

function orgFeed(roster: SyntheticEmployee[]): (FeedItem & { who: string })[] {
  return roster
    .flatMap((e) => e.feed.map((f) => ({ ...f, who: e.pseudonym })))
    .sort((a, b) => Date.parse(b.t) - Date.parse(a.t))
    .slice(0, 40);
}

function RosterCard({ employee, selected, onSelect }: { employee: SyntheticEmployee; selected: boolean; onSelect: () => void }) {
  const { trust, device, lastAlertAt, team, pseudonym } = employee;
  const color = levelColor(trust.level);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex flex-col gap-2 rounded-xl border p-3.5 text-left transition-colors hover:border-foreground/30",
        selected ? "border-foreground/50 bg-muted/40" : "border-border bg-card",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{pseudonym}</span>
        {trust.locked ? (
          <Lock className="size-4 shrink-0 text-trust-locked" />
        ) : trust.level === "suspicious" ? (
          <ShieldAlert className="size-4 shrink-0 text-trust-suspicious" />
        ) : null}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline" className="font-mono text-[10px] uppercase">
          {team}
        </Badge>
        <span className="truncate">{device.label}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="tnum text-2xl font-semibold" style={{ color }}>
          {trust.display}%
        </span>
        <span className="text-[11px] uppercase tracking-wide" style={{ color }}>
          {levelLabel(trust.level)}
        </span>
      </div>
      <div className="text-[11px] text-muted-foreground">{lastAlertAt ? `last alert ${fmtAgo(lastAlertAt)}` : "no alerts"}</div>
    </button>
  );
}

function EmployeeDetail({ employee }: { employee: SyntheticEmployee }) {
  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <Panel title="Trust" className="lg:col-span-4" bodyClassName="space-y-3">
        <TrustGauge trust={employee.trust} locked={employee.trust.locked} learning={false} />
      </Panel>
      <Panel title="Per-modality contribution" hint="last block, ΔL" className="lg:col-span-4">
        <ModalityBars trust={employee.trust} lastBlocks={{}} />
      </Panel>
      <Panel title="Why" hint="largest deviations from the enrolled profile" className="lg:col-span-4">
        <WhyChips blocks={employee.blocks} />
      </Panel>
      <Panel title={`${employee.pseudonym} · event feed`} className="lg:col-span-12" bodyClassName="flex flex-col">
        <EventFeed items={employee.feed} className="max-h-80 min-h-[160px] flex-1" />
      </Panel>
    </div>
  );
}

export function AdminView() {
  const [roster, setRoster] = useState<SyntheticEmployee[]>(() => generateRoster());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const feed = useMemo(() => orgFeed(roster), [roster]);
  const selected = roster.find((e) => e.id === selectedId) ?? null;
  const alerting = roster.filter((e) => e.trust.locked || e.trust.level === "suspicious");

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-4 px-4 py-5 sm:px-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted ring-1 ring-foreground/10">
            <Building2 className="size-5 text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Organization overview</h1>
            <p className="text-xs text-muted-foreground">
              {roster.length} synthetic, anonymized sessions · {alerting.length} need attention
            </p>
          </div>
        </div>
        <div className="lg:ml-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRoster(generateRoster());
              setSelectedId(null);
            }}
          >
            <RefreshCw /> Resimulate
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-trust-watch/40 bg-trust-watch/10 px-4 py-2.5 text-xs text-trust-watch">
        Demo data: every session below is fabricated client-side to stand in for an organization of employees. No
        real person, device or behavioral data is shown here.
      </div>

      <div className="grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <Panel title="Roster" icon={Users} hint="click a session to drill in">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {roster.map((e) => (
                <RosterCard key={e.id} employee={e} selected={e.id === selectedId} onSelect={() => setSelectedId(e.id === selectedId ? null : e.id)} />
              ))}
            </div>
          </Panel>
        </div>
        <Panel title="Audit trail" icon={AlertTriangle} hint="org-wide, newest first" className="lg:col-span-4" bodyClassName="flex flex-col">
          <EventFeed items={feed.map(({ who, ...f }) => ({ ...f, text: `${who}: ${f.text}` }))} className="max-h-[600px] min-h-[240px] flex-1" />
        </Panel>
      </div>

      {selected && <EmployeeDetail employee={selected} />}
    </div>
  );
}
