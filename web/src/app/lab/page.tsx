"use client";

import { AudioLines, FileQuestion, FlaskConical, Gauge, Layers, ScanFace, ShieldAlert, ShieldCheck, Timer, TrendingUp } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import {
  AblationChart,
  EerTable,
  EvidenceSummary,
  HearsayCard,
  HonestyPanel,
  IdentificationCard,
  NotMeasured,
  OperatingPoints,
  RedteamTable,
  RocChart,
  SampleBanner,
  TtdTrials,
} from "@/components/lab/panels";
import { dataKind } from "@/components/lab/metrics";
import { EmptyState, PageHeader } from "@/components/site/empty-state";
import { Panel } from "@/components/site/panel";
import { ResourceBadge } from "@/components/site/resource-badge";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import type { StatusOut } from "@/lib/contracts";
import { useMockMode } from "@/lib/mode";
import { useResource, type Resource } from "@/lib/resource";
import { sampleEval, sampleHearsay, sampleRedteam } from "@/lib/sample-data";
import { fmtAgo } from "@/lib/ui";

function Gate<T>({
  res,
  what,
  missing,
  children,
  h = 240,
}: {
  res: Resource<T>;
  what: string;
  /** shown when the report doesn't exist yet (404), instead of a generic empty state */
  missing?: ReactNode;
  children: (d: T) => ReactNode;
  h?: number;
}) {
  if (res.status === "loading" && !res.data) return <Skeleton className="w-full" style={{ height: h }} />;
  if (!res.data) {
    if (res.status === "empty" && missing) return <>{missing}</>;
    return (
      <EmptyState icon={FileQuestion} title={res.status === "empty" ? `No ${what} report yet` : `Couldn't load the ${what} report`} className="py-8">
        {res.status === "empty" ? "It appears here once the evaluation has been run and published." : res.error}
      </EmptyState>
    );
  }
  return <>{children(res.data)}</>;
}

/** /api/status, only to say whether voice results on this server are simulated. Never called in mock mode. */
function useVoiceMode(mock: boolean): StatusOut["voice_mode"] | undefined {
  const [mode, setMode] = useState<StatusOut["voice_mode"] | undefined>(undefined);
  useEffect(() => {
    if (mock) return;
    const ctl = new AbortController();
    api
      .status(ctl.signal)
      .then((s) => setMode(s.voice_mode ?? null))
      .catch(() => {});
    return () => ctl.abort();
  }, [mock]);
  return mock ? undefined : mode;
}

function SectionTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mt-10 mb-3 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
      <h2 className="text-lg font-semibold tracking-tight">{children}</h2>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

export default function LabPage() {
  const mock = useMockMode();
  const evalR = useResource("report:eval", (s) => api.evalReport("eval", s), { sample: sampleEval, emptyOn404: true });
  const red = useResource("report:redteam", (s) => api.evalReport("redteam", s), { sample: sampleRedteam, emptyOn404: true });
  const hear = useResource("report:hearsay", (s) => api.evalReport("hearsay", s), { sample: sampleHearsay, emptyOn404: true });
  const voiceMode = useVoiceMode(mock);
  const kind = evalR.data ? dataKind(evalR.data) : null;

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-8 sm:px-6">
      {(mock || kind === "sample") && <SampleBanner />}

      <PageHeader
        eyebrow="Verification evidence"
        title="Is it still you?"
        actions={
          <>
            {kind === "real" && (
              <Badge variant="outline" className="gap-1 border-trust-normal/40">
                <ShieldCheck className="text-trust-normal" /> real recordings
              </Badge>
            )}
            {kind === "synthetic" && (
              <Badge variant="outline" className="gap-1 border-trust-watch/45 text-trust-watch">
                <FlaskConical /> synthetic data only
              </Badge>
            )}
            {kind === "sample" && (
              <Badge variant="outline" className="gap-1 border-trust-watch/45 text-trust-watch">
                <FlaskConical /> SAMPLE
              </Badge>
            )}
            {evalR.data && <span className="text-xs text-muted-foreground">eval generated {fmtAgo(evalR.data.generated_at)}</span>}
          </>
        }
      >
        2bME never asks who you are. It asks one question, all the time: <b className="text-foreground">is this still the enrolled person?</b> This
        page is the evidence for that one-class, A-vs-not-A claim: how well each behavioral branch separates the owner (A) from someone else, how fast a
        live takeover is caught, and whether the voice step-up stops cloned voices. Weak numbers included.
      </PageHeader>

      <Gate
        res={evalR}
        what="evaluation"
        h={120}
        missing={
          <NotMeasured icon={FileQuestion} title="No evaluation report published yet">
            reports/eval.json appears here once A&apos;s recordings have been scored against a teammate&apos;s.
          </NotMeasured>
        }
      >
        {(r) => (
          <>
            <EvidenceSummary report={r} />

            <SectionTitle sub="held-out blocks: A's later sessions vs a teammate who was never trained on">Can behavior tell A from not-A?</SectionTitle>
            <div className="grid gap-4 xl:grid-cols-12">
              <Panel title="ROC per branch" icon={TrendingUp} hint="A vs not-A" action={<ResourceBadge res={evalR} />} className="xl:col-span-7">
                <RocChart report={r} />
              </Panel>
              <Panel title="EER and AUC" icon={Layers} hint="lower EER is better" className="xl:col-span-5" bodyClassName="px-2">
                <EerTable report={r} />
              </Panel>

              <Panel title="FAR / FRR" icon={Gauge} hint="at the 40% alert threshold" className="xl:col-span-4">
                <OperatingPoints report={r} />
              </Panel>
              <Panel title="Branch ablation" icon={Layers} hint="fused EER, one branch removed" className="xl:col-span-4">
                <AblationChart report={r} />
              </Panel>
              <Panel title="Live takeover trials" icon={Timer} hint="time to detection" className="xl:col-span-4">
                <TtdTrials report={r} />
              </Panel>

              <Panel title="What these numbers are, and aren't" icon={ShieldCheck} className="xl:col-span-8">
                <HonestyPanel report={r} />
              </Panel>
              <Panel title="Verification, not identification" icon={ScanFace} className="xl:col-span-4">
                <IdentificationCard report={r} />
              </Panel>
            </div>
          </>
        )}
      </Gate>

      <SectionTitle
        sub={
          voiceMode === "stub" ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-trust-watch/45 bg-trust-watch/10 px-2.5 py-0.5 font-medium text-trust-watch">
              <FlaskConical className="size-3" /> Voice on this server is simulated (stub): its results are canned, not measured.
            </span>
          ) : (
            "the independent check that decides when behavior raises the alarm"
          )
        }
      >
        Voice step-up
      </SectionTitle>
      <div className="grid gap-4 xl:grid-cols-12">
        <Panel title="Red team: cloned and replayed voices" icon={ShieldAlert} action={<ResourceBadge res={red} />} className="xl:col-span-7">
          <Gate
            res={red}
            what="red-team"
            missing={
              <NotMeasured title="Not yet measured">
                No clone-attack results are published yet. Once they are, this table shows how often each ElevenLabs attack class is accepted by the
                speaker match alone, the anti-spoof check alone, and 2bME&apos;s fused decision.
              </NotMeasured>
            }
          >
            {(d) => <RedteamTable report={d} />}
          </Gate>
        </Panel>
        <Panel title="NSA Hearsay" icon={AudioLines} hint="synthetic-speech detection" action={<ResourceBadge res={hear} />} className="xl:col-span-5">
          <Gate
            res={hear}
            what="Hearsay"
            missing={
              <NotMeasured title="Not yet measured">
                No Hearsay development-set run is published yet. When it is, this card shows minDCF and EER for the anti-spoof detectors behind the
                voice check.
              </NotMeasured>
            }
          >
            {(d) => <HearsayCard report={d} />}
          </Gate>
        </Panel>
      </div>

      <p className="mt-8 border-t pt-4 text-xs text-muted-foreground">
        Impostor data comes from teammates only (2 people). Numbers are small-sample development evidence and are quoted as measured, including where
        they are weak.
      </p>
    </div>
  );
}
