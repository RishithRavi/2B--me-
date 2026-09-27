"use client";

// Admin/org control panel (§2.4, ADOPTED): the .tech site's job. A cyber admin watches every employee's continuous
// trust, gets alerted the moment someone deviates (takeover, insider drift, remote session), acts (lock, force
// re-verify, acknowledge, note) and traces a breach back through the audit trail.
// source="live": GET /api/admin/roster + /api/admin/audit + /ws/live?scope=org (admin only).
// source="demo": the seeded synthetic org in lib/admin-mock.ts, clearly labelled, same shapes and reducer.
import { Building2, CloudOff, Database, FlaskConical, Radio, Sprout } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/site/empty-state";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import type { AdminActionIn, Level } from "@/lib/contracts";
import { useNow } from "@/lib/hooks";
import {
  ackedRefs,
  alertCounts,
  alertingDrops,
  alertRows,
  levelDrops,
  orgKpis,
  sortRoster,
  useOrgLive,
  type RosterSort,
} from "@/lib/org-live";
import { fmtAgo, levelLabel } from "@/lib/ui";
import { cn } from "@/lib/utils";

import { AlertsRail } from "./alerts-rail";
import { AuditTrail, type AuditFilter } from "./audit-trail";
import { EmployeeDrawer } from "./employee-drawer";
import { KpiStrip } from "./kpi-strip";
import { lockReasonText } from "./org-bits";
import { RiskMap } from "./risk-map";
import { Roster } from "./roster";

const FAILED_VERB: Record<AdminActionIn["action"], string> = {
  lock: "lock the device",
  unlock: "clear the admin lock",
  force_reverify: "request a re-verification",
  ack_alert: "acknowledge the alert",
  note: "add the note",
};

function SourceToggle({ source }: { source: "live" | "demo" }) {
  // Full page loads on purpose: ?mock=1 / ?mock=0 set or clear the tab's sticky mock mode (lib/mode.ts).
  return (
    <div className="inline-flex rounded-lg bg-muted p-0.5 text-xs" role="group" aria-label="Data source">
      <a
        href="/admin?mock=0"
        aria-current={source === "live" ? "page" : undefined}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium text-muted-foreground transition-colors hover:text-foreground",
          source === "live" && "bg-card text-foreground shadow-sm ring-1 ring-foreground/10",
        )}
      >
        <Radio className="size-3.5" /> Live org
      </a>
      <a
        href="/admin?mock=1"
        aria-current={source === "demo" ? "page" : undefined}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium text-muted-foreground transition-colors hover:text-foreground",
          source === "demo" && "bg-card text-trust-watch shadow-sm ring-1 ring-trust-watch/30",
        )}
      >
        <FlaskConical className="size-3.5" /> Demo org
      </a>
    </div>
  );
}

function StreamPill({ source, connected, lastEventAt, now }: { source: "live" | "demo"; connected: boolean; lastEventAt: number | null; now: number }) {
  const age = lastEventAt ? fmtAgo(new Date(lastEventAt).toISOString(), now) : null;
  const color = source === "demo" ? "var(--trust-watch)" : connected ? "var(--trust-normal)" : "var(--trust-suspicious)";
  const label = source === "demo" ? "Simulated stream" : connected ? "Live stream" : "Reconnecting…";
  return (
    <span className="inline-flex h-7 items-center gap-2 rounded-lg px-2.5 text-xs ring-1 ring-foreground/10">
      <span className="relative flex size-2">
        {(connected || source === "demo") && <span className="absolute inset-0 animate-ping rounded-full opacity-60" style={{ background: color }} />}
        <span className="relative size-2 rounded-full" style={{ background: color }} />
      </span>
      <span className="font-medium">{label}</span>
      {age && <span className="tnum text-muted-foreground">· {age}</span>}
    </span>
  );
}

export function AdminView({ source, preview = false }: { source: "live" | "demo"; preview?: boolean }) {
  const mock = source === "demo";
  const { state, store } = useOrgLive({ mock });
  const now = useNow(preview ? 0 : 1000);
  const params = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sort, setSort] = useState<RosterSort>("risk");
  const [filter, setFilter] = useState<AuditFilter>({ kind: "all", device: "all" });

  const rows = useMemo(() => sortRoster(state.rows, sort), [state.rows, sort]);
  const kpis = useMemo(() => orgKpis(state.rows, state.audit, now), [state.rows, state.audit, now]);
  const alerts = useMemo(() => alertRows(state.audit), [state.audit]);
  const acked = useMemo(() => ackedRefs(state.audit), [state.audit]);
  const alertCountBy = useMemo(() => alertCounts(state.audit, now), [state.audit, now]);
  const lastAlertBy = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of alerts) if (a.device_id && !m.has(a.device_id)) m.set(a.device_id, a.t);
    for (const r of state.rows) {
      const t = r.last_anomaly_at;
      const cur = m.get(r.device_id);
      if (t && (!cur || Date.parse(t) > Date.parse(cur))) m.set(r.device_id, t);
    }
    return m;
  }, [alerts, state.rows]);
  const selected = selectedId ? (state.rows.find((r) => r.device_id === selectedId) ?? null) : null;
  const synthetic = kpis.synthetic;

  const select = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  // Breach trace-back: close the drill-in, filter the audit trail to that device and bring it into view.
  const auditRef = useRef<HTMLDivElement>(null);
  const trace = useCallback((id: string) => {
    setSelectedId(null);
    setFilter({ kind: "all", device: id });
    setTimeout(() => auditRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 250);
  }, []);

  // Deep link: /admin?device_id=<uuid> or /admin?employee=07 opens that drill-in once the roster is in.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (preview || deepLinked.current || !state.loaded || state.rows.length === 0) return;
    deepLinked.current = true;
    const dev = params.get("device_id");
    const emp = params.get("employee");
    const hit = dev
      ? state.rows.find((r) => r.device_id === dev)
      : emp
        ? state.rows.find((r) => r.handle.endsWith(` ${emp.padStart(2, "0")}`))
        : undefined;
    if (hit) setSelectedId(hit.device_id);
  }, [params, preview, state.loaded, state.rows]);

  // Toast when anyone drops to Suspicious, gets locked or starts drifting (never for the state on arrival).
  const prevLevels = useRef<Map<string, Level> | null>(null);
  const prevFlags = useRef<Map<string, readonly string[]> | null>(null);
  useEffect(() => {
    if (preview || !state.loaded || state.rows.length === 0) return;
    const drops = levelDrops(prevLevels.current, state.rows);
    prevLevels.current = new Map(state.rows.map((r) => [r.device_id, r.level]));
    const flagsBefore = prevFlags.current;
    prevFlags.current = new Map(state.rows.map((r) => [r.device_id, r.flags]));
    if (flagsBefore) {
      for (const r of state.rows) {
        const was = flagsBefore.get(r.device_id);
        if (!was || was.includes("insider_drift") || !r.flags.includes("insider_drift")) continue;
        toast.warning(`${r.handle} · insider drift`, {
          id: `drift-${r.device_id}`,
          description: "Sustained deviation over 5 min. Review activity; behavior alone never blocks.",
          duration: 9000,
          action: { label: "Inspect", onClick: () => select(r.device_id) },
        });
      }
    }
    const alerting = alertingDrops(drops);
    for (const d of alerting.slice(0, 3)) {
      const r = d.row;
      const title = d.to === "locked" ? `${r.handle} locked` : `${r.handle} dropped to ${r.display ?? "—"}% · ${levelLabel(r.level)}`;
      const description =
        d.to === "locked"
          ? `${lockReasonText(r.lock_reason)} · ${r.team ?? r.device_label}`
          : r.flags.includes("takeover_suspected")
            ? `Takeover suspected on ${r.device_label}. A voice check decides; behavior alone never blocks.`
            : `${r.handle}'s behavior no longer matches their baseline.`;
      toast.error(title, {
        id: `drop-${r.device_id}-${d.to}`,
        description,
        duration: 9000,
        action: { label: "Inspect", onClick: () => select(r.device_id) },
      });
    }
  }, [preview, select, state.loaded, state.rows]);

  const onAction = useCallback(
    async (input: AdminActionIn, label: string): Promise<boolean> => {
      if (!store) return false;
      const who = state.rows.find((r) => r.device_id === input.device_id)?.handle ?? "device";
      try {
        await store.act(input);
        // Top-center: action results come from the drill-in drawer, which covers the top-right corner.
        toast.success(`${label} · ${who}`, {
          position: "top-center",
          description: mock ? "Simulated action, written to the demo audit trail." : "Written to the audit trail.",
        });
        return true;
      } catch (e) {
        toast.error(`Couldn't ${FAILED_VERB[input.action]} · ${who}`, { position: "top-center", description: errorMessage(e) });
        return false;
      }
    },
    [mock, state.rows, store],
  );

  const [seeding, setSeeding] = useState(false);
  async function seed() {
    setSeeding(true);
    try {
      const out = await api.demoOrgSeed(19);
      toast.success(`Seeded ${out.employees.length} pseudonymous employees`, {
        description: "Stream them through the hub with scripts/core_org_demo.py.",
      });
      await store?.sync(true);
    } catch (e) {
      toast.error("Seeding failed", { description: errorMessage(e) });
    } finally {
      setSeeding(false);
    }
  }

  const loading = !state.loaded;
  const liveProblem = !mock && state.loaded && state.error !== null && state.rows.length === 0;
  const empty = (
    <EmptyState
      icon={liveProblem ? CloudOff : Sprout}
      title={
        liveProblem
          ? state.errorStatus === 404
            ? "The org endpoints aren't on this server yet"
            : state.errorStatus === 401 || state.errorStatus === 403
              ? "This session isn't an admin"
              : "Can't reach the org API"
          : "No devices on the roster yet"
      }
      action={
        <div className="flex flex-wrap justify-center gap-2">
          {!liveProblem && (
            <Button size="sm" variant="outline" disabled={seeding} onClick={() => void seed()}>
              <Database /> Seed 19 pseudonymous employees
            </Button>
          )}
          <Button asChild size="sm">
            <a href="/admin?mock=1">
              <FlaskConical /> Open the demo org
            </a>
          </Button>
        </div>
      }
    >
      {liveProblem
        ? `${state.error ?? "Unknown error"}. The demo org runs the same panel on synthetic data in your browser.`
        : "Enrolled devices appear here with their live trust. Seed the pseudonymous org demo and stream it with scripts/core_org_demo.py."}
    </EmptyState>
  );

  return (
    <div className="relative">
      <div aria-hidden className="bg-console-grid pointer-events-none absolute inset-x-0 top-0 h-72 [mask-image:linear-gradient(to_bottom,black,transparent)] opacity-70" />
      <div className="relative mx-auto w-full max-w-[1440px] space-y-4 px-4 py-5 sm:px-6">
        {/* Header */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-card ring-1 ring-foreground/10">
              <Building2 className="size-5 text-brand" />
            </div>
            <div className="min-w-0">
              <div className="eyebrow">
                2bME for organizations<span className="hidden sm:inline"> · admin console</span>
              </div>
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Org control panel</h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
            <StreamPill source={source} connected={state.connected} lastEventAt={state.lastEventAt ?? state.lastSyncAt} now={now} />
            {!preview && <SourceToggle source={source} />}
          </div>
        </div>

        {/* Synthetic labelling */}
        {mock ? (
          <div className="flex items-start gap-3 rounded-xl border border-trust-watch/40 bg-trust-watch/8 px-4 py-2.5 text-[13px]">
            <FlaskConical className="mt-0.5 size-4 shrink-0 text-trust-watch" />
            <p className="min-w-0">
              <span className="font-semibold tracking-wide text-trust-watch uppercase">Synthetic: anonymized demo employees.</span>{" "}
              <span className="text-muted-foreground">
                {kpis.total || 20} pseudonymous employees simulated in your browser from a fixed seed, emitting the same events as the live hub. No
                real person, device or behavioral data.
              </span>
            </p>
          </div>
        ) : synthetic > 0 ? (
          <div className="flex items-start gap-3 rounded-xl border border-trust-watch/30 bg-trust-watch/6 px-4 py-2.5 text-[13px]">
            <FlaskConical className="mt-0.5 size-4 shrink-0 text-trust-watch" />
            <p className="min-w-0 text-muted-foreground">
              <span className="font-medium text-trust-watch">{synthetic} of {kpis.total} rows are synthetic</span> pseudonymous org-demo employees
              streamed through the real hub. Rows tagged <span className="font-mono text-[11px] text-brand uppercase">real device</span> are live
              enrolled devices.
            </p>
          </div>
        ) : null}

        <KpiStrip kpis={kpis} loading={loading} />

        {!loading && state.rows.length > 0 && <RiskMap rows={state.rows} selectedId={selectedId} onSelect={select} />}

        <div className="grid gap-4 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-8">
            <Roster
              rows={rows}
              lastAlertBy={lastAlertBy}
              now={now}
              selectedId={selectedId}
              onSelect={select}
              sort={sort}
              onSort={setSort}
              loading={loading}
              empty={empty}
            />
          </div>
          <div className="min-w-0 lg:col-span-4">
            <AlertsRail alerts={alerts} acked={acked} rows={state.rows} counts={alertCountBy} now={now} onSelect={select} className="lg:sticky lg:top-18 lg:max-h-[calc(100dvh-5.5rem)]" />
          </div>
        </div>

        <div ref={auditRef} className="scroll-mt-20">
          <AuditTrail audit={state.audit} rows={state.rows} filter={filter} onFilter={setFilter} onSelect={select} now={now} mock={mock} />
        </div>

        {!mock && state.loaded && state.error && state.rows.length > 0 && (
          <p className="text-xs text-trust-watch">Last refresh failed: {state.error}. Showing the most recent data; retrying every 30 s.</p>
        )}
        {!mock && (
          <p className="text-[11.5px] text-muted-foreground">
            Roster re-syncs every 30&nbsp;s; events stream live.{" "}
            <Link href="/dashboard?stage=1" className="underline underline-offset-4">
              Stage view
            </Link>
          </p>
        )}
      </div>

      {!preview && (
        <EmployeeDrawer
          row={selected}
          audit={state.audit}
          acked={acked}
          now={now}
          mock={mock}
          onClose={() => setSelectedId(null)}
          onAction={onAction}
          onTrace={trace}
        />
      )}
    </div>
  );
}
