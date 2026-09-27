"use client";

import { Database, FlaskConical, History as HistoryIcon, ListTree, LogIn, RefreshCw, Ruler, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";

import { useVoiceMode } from "@/components/dashboard/voice-mode";
import { AnomaliesList, BaselineTable, SessionsTable, TigerCard } from "@/components/history/panels";
import { TrustTimeline } from "@/components/history/trust-timeline";
import { EmptyState, PageHeader } from "@/components/site/empty-state";
import { Panel } from "@/components/site/panel";
import { ResourceBadge } from "@/components/site/resource-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, request } from "@/lib/api";
import type { AnomalyRow, Modality, SessionRow } from "@/lib/contracts";
import { useMockMode } from "@/lib/mode";
import { useResource, type Resource } from "@/lib/resource";
import { sampleAnomalies, sampleBaseline, sampleSessions, sampleTiger, sampleTrust } from "@/lib/sample-data";
import { useMe } from "@/lib/session";
import { MODALITIES, modalityLabel, shortId } from "@/lib/ui";

function Body<T>({
  res,
  empty,
  emptyAction,
  children,
  skeleton = 160,
}: {
  res: Resource<T>;
  empty: string;
  emptyAction?: ReactNode;
  children: (data: T) => ReactNode;
  skeleton?: number;
}) {
  if (res.status === "loading" && !res.data) return <Skeleton className="w-full" style={{ height: skeleton }} />;
  if (!res.data || (Array.isArray(res.data) && res.data.length === 0)) {
    return (
      <EmptyState icon={Database} title={res.status === "error" ? "Couldn't load this" : empty} action={res.status === "error" ? undefined : emptyAction} className="py-8">
        {res.status === "error" ? res.error : null}
      </EmptyState>
    );
  }
  return <>{children(res.data)}</>;
}

/** Who a device belongs to, for naming it in the trace-back view. */
interface DeviceInfo {
  handle: string;
  team: string | null;
  device_label: string;
  synthetic: boolean;
}

/** Full name for the page title: "Employee 07 · People · synthetic", or the real device's label. */
function deviceTitle(d: DeviceInfo): string {
  return d.synthetic ? [d.handle, d.team, "synthetic"].filter(Boolean).join(" · ") : d.device_label;
}

/** Short name for a table row: the synthetic employee's handle, or the real device's label. */
function deviceShort(d: DeviceInfo): string {
  return d.synthetic ? d.handle : d.device_label;
}

/** A session worth opening by default: long enough to draw a timeline, or one that recorded an anomaly. */
function substantial(s: SessionRow): boolean {
  return s.n_ticks >= 12 || s.n_anomalies > 0;
}

/** Ended sessions with at most one tick (a reset or reconnect blip) are noise in the list. */
function blip(s: SessionRow): boolean {
  return s.status !== "active" && s.n_ticks <= 1 && s.n_anomalies === 0;
}

type ExplanationSource = "vultr" | "template" | null;

/** One /status read for where anomaly explanations come from (inference.explanations). Mock mode: the template. */
function useExplanationSource(mock: boolean): ExplanationSource {
  const [src, setSrc] = useState<ExplanationSource>(null);
  useEffect(() => {
    if (mock) return;
    const ctl = new AbortController();
    api
      .status(ctl.signal)
      .then((s) => {
        const v = s.inference?.["explanations"];
        setSrc(v === "vultr" || v === "template" ? v : null);
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [mock]);
  return mock ? "template" : src;
}

// Deep links from /admin (breach trace-back): ?session_id=<id> opens that session; ?device_id=<id> shows only that
// device's sessions and anomalies (the server filters when it supports device_id; this page always filters too) and
// opens its most recent real session. Without params the newest real session opens, not a just-reset empty one.
export default function HistoryPage() {
  return (
    <Suspense fallback={null}>
      <HistoryInner />
    </Suspense>
  );
}

function HistoryInner() {
  const params = useSearchParams();
  const sessionParam = params.get("session_id");
  const deviceParam = params.get("device_id");
  const me = useMe();
  const mock = useMockMode();
  const isAdmin = mock || me.me?.role === "admin";
  const [picked, setPicked] = useState<string | null>(null);
  const [modality, setModality] = useState<Modality>("keyboard");
  // History needs a session cookie: wait for /me, and never fire requests that can only 401 for a visitor.
  const anon = !mock && me.status === "anon";
  const ready = mock || me.status === "ok" || me.status === "offline";
  const voiceSimulated = useVoiceMode(mock) === "stub";
  const explanations = useExplanationSource(mock);

  // Trace-back: ask the server for this device only, and filter here as well so an older server can't leak others in.
  const byDevice = Boolean(deviceParam && !mock);
  const sessions = useResource(
    ready ? `history:sessions:${deviceParam ?? "all"}` : null,
    (s) =>
      byDevice
        ? request<SessionRow[]>("GET", "/history/sessions", { query: { limit: 50, device_id: deviceParam }, signal: s })
        : api.historySessions(50, s),
    { sample: () => sampleSessions() },
  );
  const sessionRows = useMemo(
    () => (sessions.data ? sessions.data.filter((r) => (deviceParam ? r.device_id === deviceParam : true) && !blip(r)) : null),
    [sessions.data, deviceParam],
  );
  const linked = sessionParam ?? (sessionRows?.find(substantial) ?? sessionRows?.[0])?.session_id ?? null;
  const sessionId = picked ?? linked;
  const trust = useResource(ready && sessionId ? `history:trust:${sessionId}` : null, (s) => api.historyTrust({ session_id: sessionId }, s), {
    sample: () => sampleTrust(sessionId ?? ""),
  });
  const anomalies = useResource(
    ready ? `history:anomalies:${deviceParam ?? "all"}` : null,
    (s) =>
      byDevice
        ? request<AnomalyRow[]>("GET", "/history/anomalies", { query: { limit: 50, device_id: deviceParam }, signal: s })
        : api.historyAnomalies(50, s),
    { sample: () => sampleAnomalies() },
  );
  const anomalyRows = useMemo(
    () => (anomalies.data && deviceParam ? anomalies.data.filter((a) => a.device_id === deviceParam) : anomalies.data),
    [anomalies.data, deviceParam],
  );
  const baseline = useResource(ready ? `history:baseline:${modality}:${sessionId ?? "all"}` : null, (s) => api.historyBaseline(modality, sessionId, s), {
    sample: () => sampleBaseline(modality, sessionId),
  });
  const tiger = useResource(ready ? "tiger:stats" : null, (s) => api.tigerStats(s), { sample: () => sampleTiger() });

  // Name devices: admins see the org roster; a user only ever sees their own device.
  const roster = useResource(!mock && me.me?.role === "admin" ? "admin:roster" : null, (s) => api.adminRoster(s));
  const devices = useMemo(() => {
    const m = new Map<string, DeviceInfo>();
    for (const r of roster.data ?? []) m.set(r.device_id, { handle: r.handle, team: r.team, device_label: r.device_label, synthetic: r.synthetic });
    const own = me.me?.device;
    if (own && !m.has(own.id)) m.set(own.id, { handle: me.me?.handle ?? "", team: null, device_label: own.label, synthetic: false });
    return m;
  }, [roster.data, me.me]);
  const nameOf = (id: string | null) => (id ? devices.get(id) : undefined);
  const traced = deviceParam ? nameOf(deviceParam) : undefined;
  const selectedDevice = nameOf(sessionRows?.find((r) => r.session_id === sessionId)?.device_id ?? deviceParam);

  if (anon) {
    return (
      <div className="mx-auto w-full max-w-lg px-4 py-20">
        <div className="panel">
          <EmptyState
            icon={LogIn}
            title="Sign in to see behavior history"
            action={
              <div className="flex gap-2">
                <Button asChild size="sm">
                  <Link href="/login?next=/history">
                    <LogIn /> Log in
                  </Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <a href="/history?mock=1">
                    <FlaskConical /> Sample data
                  </a>
                </Button>
              </div>
            }
          >
            Sessions, trust timelines, anomalies and baselines come from Tiger for your own devices (admins: the whole org).
          </EmptyState>
        </div>
      </div>
    );
  }

  const reloadAll = () => {
    sessions.reload();
    trust.reload();
    anomalies.reload();
    baseline.reload();
    tiger.reload();
  };

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-8 sm:px-6">
      <PageHeader
        eyebrow="Tiger Data · behavior history"
        title={deviceParam ? `Trace-back · ${traced ? deviceTitle(traced) : `device ${shortId(deviceParam)}`}` : "History"}
        actions={
          <Button variant="outline" size="sm" onClick={reloadAll}>
            <RefreshCw /> Refresh
          </Button>
        }
      >
        Every tick, block, anomaly and voice attempt lands in Tiger hypertables. Sessions, gap-filled trust, baselines and compression
        all come straight from there. If the API is unreachable, the last good copy from this browser is shown and marked cached.
      </PageHeader>

      <div className="grid gap-4 xl:grid-cols-12">
        <Panel title="Sessions" icon={HistoryIcon} action={<ResourceBadge res={sessions} />} className="xl:col-span-7" bodyClassName="px-2">
          <Body
            res={{ ...sessions, data: sessionRows }}
            empty={deviceParam ? "No sessions for this device in history" : "No sessions yet"}
            emptyAction={
              deviceParam ? (
                <Button asChild size="sm" variant="outline">
                  <Link href="/history">Show all sessions</Link>
                </Button>
              ) : undefined
            }
          >
            {(rows) => (
              <SessionsTable
                rows={rows}
                selected={sessionId}
                onSelect={setPicked}
                deviceLabel={(id) => {
                  const d = nameOf(id);
                  return d ? deviceShort(d) : null;
                }}
              />
            )}
          </Body>
        </Panel>
        <Panel title="Tiger" icon={Database} hint="hypertables · columnstore · jobs" action={<ResourceBadge res={tiger} />} className="xl:col-span-5">
          <Body res={tiger} empty="No stats">
            {(t) => <TigerCard stats={t} isAdmin={isAdmin} mock={mock} onCompressed={() => setTimeout(tiger.reload, 1500)} />}
          </Body>
        </Panel>

        <Panel
          title="Trust timeline"
          icon={TrendingUp}
          hint={
            sessionId
              ? `session ${sessionId.slice(0, 8)}${selectedDevice ? ` · ${deviceShort(selectedDevice)}` : ""} · avg with min–max band`
              : undefined
          }
          action={<ResourceBadge res={trust} />}
          className="xl:col-span-12"
        >
          {sessionId ? (
            <Body res={trust} empty="No trust data for this session" skeleton={260}>
              {(t) => <TrustTimeline series={t} />}
            </Body>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">Pick a session.</p>
          )}
        </Panel>

        <Panel title="Anomalies" icon={ListTree} hint="with explanations and challenge outcome" action={<ResourceBadge res={anomalies} />} className="xl:col-span-7">
          <Body res={{ ...anomalies, data: anomalyRows }} empty={deviceParam ? "No anomalies recorded for this device" : "No anomalies yet"}>
            {(rows) => <AnomaliesList rows={rows} voiceSimulated={voiceSimulated} explanations={explanations} />}
          </Body>
        </Panel>

        <Panel title="Baseline vs session" icon={Ruler} action={<ResourceBadge res={baseline} />} className="xl:col-span-5">
          <Tabs value={modality} onValueChange={(v) => setModality(v as Modality)} className="mb-3">
            <TabsList className="w-full">
              {MODALITIES.map((m) => (
                <TabsTrigger key={m} value={m} className="text-xs">
                  {modalityLabel(m, true)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Body res={baseline} empty="No baseline for this modality yet">
            {(b) => <BaselineTable rows={b.rows} />}
          </Body>
        </Panel>
      </div>
    </div>
  );
}
