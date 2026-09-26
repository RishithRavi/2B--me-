"use client";

import { AudioLines, FileQuestion, FlaskConical, Grid2x2, Layers, ShieldAlert, Timer, TrendingUp } from "lucide-react";

import { AblationChart, ConfusionMatrix, EerTable, HearsayCard, RedteamTable, RocChart, TtdTrials } from "@/components/lab/panels";
import { EmptyState, PageHeader } from "@/components/site/empty-state";
import { Panel } from "@/components/site/panel";
import { ResourceBadge } from "@/components/site/resource-badge";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useResource, type Resource } from "@/lib/resource";
import { sampleEval, sampleHearsay, sampleRedteam } from "@/lib/sample-data";
import { fmtAgo } from "@/lib/ui";

function Gate<T>({ res, what, children, h = 240 }: { res: Resource<T>; what: string; children: (d: T) => React.ReactNode; h?: number }) {
  if (res.status === "loading" && !res.data) return <Skeleton className="w-full" style={{ height: h }} />;
  if (!res.data) {
    return (
      <EmptyState icon={FileQuestion} title={res.status === "empty" ? `No ${what} report yet` : `Couldn't load the ${what} report`} className="py-8">
        {res.status === "empty" ? "It appears here once the evaluation has been run and reports/*.json is published." : res.error}
      </EmptyState>
    );
  }
  return <>{children(res.data)}</>;
}

export default function LabPage() {
  const evalR = useResource("report:eval", (s) => api.evalReport("eval", s), { sample: sampleEval, emptyOn404: true });
  const red = useResource("report:redteam", (s) => api.evalReport("redteam", s), { sample: sampleRedteam, emptyOn404: true });
  const hear = useResource("report:hearsay", (s) => api.evalReport("hearsay", s), { sample: sampleHearsay, emptyOn404: true });
  const sampleNote = evalR.data?.notes.find((n) => n.toUpperCase().includes("SAMPLE"));

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-8 sm:px-6">
      <PageHeader
        eyebrow="Evidence"
        title="Lab"
        actions={
          <>
            {sampleNote && (
              <Badge variant="outline" className="gap-1 border-trust-watch/45 text-trust-watch">
                <FlaskConical /> {sampleNote}
              </Badge>
            )}
            {evalR.data && <span className="text-xs text-muted-foreground">eval generated {fmtAgo(evalR.data.generated_at)}</span>}
          </>
        }
      >
        Does timing alone tell two people apart? Each behavioral branch is scored A-vs-B on held-out blocks, then fused. Then we check how
        fast a live takeover is caught, and whether the voice step-up stops cloned voices.
      </PageHeader>

      <h2 className="eyebrow mb-3">Can behavior identify a person?</h2>
      <div className="grid gap-4 xl:grid-cols-12">
        <Panel title="ROC per branch" icon={TrendingUp} hint="A (genuine) vs B (impostor) blocks" action={<ResourceBadge res={evalR} />} className="xl:col-span-7">
          <Gate res={evalR} what="eval" h={320}>
            {(r) => <RocChart report={r} />}
          </Gate>
        </Panel>
        <Panel title="EER / AUC" icon={Layers} hint="lower EER is better" className="xl:col-span-5" bodyClassName="px-2">
          <Gate res={evalR} what="eval">
            {(r) => <EerTable report={r} />}
          </Gate>
        </Panel>
        <Panel title="Branch ablation" icon={Layers} hint="fused EER with one branch removed" className="xl:col-span-5">
          <Gate res={evalR} what="eval">
            {(r) => <AblationChart report={r} />}
          </Gate>
        </Panel>
        <Panel title="Identification" icon={Grid2x2} hint="confusion matrix, A vs B" className="xl:col-span-3">
          <Gate res={evalR} what="eval">
            {(r) => <ConfusionMatrix report={r} />}
          </Gate>
        </Panel>
        <Panel title="Live takeover trials" icon={Timer} hint="time to detection" className="xl:col-span-4">
          <Gate res={evalR} what="eval">
            {(r) => <TtdTrials report={r} />}
          </Gate>
        </Panel>
      </div>

      <h2 className="eyebrow mt-10 mb-3">Voice step-up</h2>
      <div className="grid gap-4 xl:grid-cols-12">
        <Panel title="Red team: ElevenLabs clones and replays" icon={ShieldAlert} action={<ResourceBadge res={red} />} className="xl:col-span-7">
          <Gate res={red} what="red-team">
            {(r) => <RedteamTable report={r} />}
          </Gate>
        </Panel>
        <Panel title="NSA Hearsay" icon={AudioLines} hint="synthetic-speech detection" action={<ResourceBadge res={hear} />} className="xl:col-span-5">
          <Gate res={hear} what="Hearsay">
            {(r) => <HearsayCard report={r} />}
          </Gate>
        </Panel>
      </div>

      <p className="mt-8 border-t pt-4 text-sm text-muted-foreground">
        Impostor data comes from teammates only (2 people); numbers are small-sample.
      </p>
    </div>
  );
}
