"use client";

import { Database, History as HistoryIcon, ListTree, RefreshCw, Ruler, TrendingUp } from "lucide-react";
import { useState } from "react";

import { AnomaliesList, BaselineTable, SessionsTable, TigerCard } from "@/components/history/panels";
import { TrustTimeline } from "@/components/history/trust-timeline";
import { EmptyState, PageHeader } from "@/components/site/empty-state";
import { Panel } from "@/components/site/panel";
import { ResourceBadge } from "@/components/site/resource-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import type { Modality } from "@/lib/contracts";
import { useMockMode } from "@/lib/mode";
import { useResource, type Resource } from "@/lib/resource";
import { sampleAnomalies, sampleBaseline, sampleSessions, sampleTiger, sampleTrust } from "@/lib/sample-data";
import { useMe } from "@/lib/session";
import { MODALITIES, modalityLabel } from "@/lib/ui";

function Body<T>({ res, empty, children, skeleton = 160 }: { res: Resource<T>; empty: string; children: (data: T) => React.ReactNode; skeleton?: number }) {
  if (res.status === "loading" && !res.data) return <Skeleton className="w-full" style={{ height: skeleton }} />;
  if (!res.data || (Array.isArray(res.data) && res.data.length === 0)) {
    return (
      <EmptyState icon={Database} title={res.status === "error" ? "Couldn't load this" : empty} className="py-8">
        {res.status === "error" ? res.error : null}
      </EmptyState>
    );
  }
  return <>{children(res.data)}</>;
}

export default function HistoryPage() {
  const me = useMe();
  const mock = useMockMode();
  const isAdmin = mock || me.me?.role === "admin";
  const [picked, setPicked] = useState<string | null>(null);
  const [modality, setModality] = useState<Modality>("keyboard");

  const sessions = useResource("history:sessions", (s) => api.historySessions(50, s), { sample: () => sampleSessions() });
  const sessionId = picked ?? sessions.data?.[0]?.session_id ?? null;
  const trust = useResource(sessionId ? `history:trust:${sessionId}` : null, (s) => api.historyTrust({ session_id: sessionId }, s), {
    sample: () => sampleTrust(sessionId ?? ""),
  });
  const anomalies = useResource("history:anomalies", (s) => api.historyAnomalies(50, s), { sample: () => sampleAnomalies() });
  const baseline = useResource(`history:baseline:${modality}:${sessionId ?? "all"}`, (s) => api.historyBaseline(modality, sessionId, s), {
    sample: () => sampleBaseline(modality, sessionId),
  });
  const tiger = useResource("tiger:stats", (s) => api.tigerStats(s), { sample: () => sampleTiger() });

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
        title="History"
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
          <Body res={sessions} empty="No sessions yet">
            {(rows) => <SessionsTable rows={rows} selected={sessionId} onSelect={setPicked} />}
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
          hint={sessionId ? `session ${sessionId.slice(0, 8)} · avg with min–max band` : undefined}
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
          <Body res={anomalies} empty="No anomalies — nobody else has used this laptop">
            {(rows) => <AnomaliesList rows={rows} />}
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
