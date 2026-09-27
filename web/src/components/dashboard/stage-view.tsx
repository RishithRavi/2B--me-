"use client";

import { Building2, Flag, FlagOff, Loader2, RotateCcw, Target, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Wordmark } from "@/components/site/logo";
import { Button } from "@/components/ui/button";
import { useNow } from "@/lib/hooks";
import type { LiveState } from "@/lib/live";
import { takeoverOpen } from "@/lib/ttd";
import { scoredModalities } from "@/lib/ui";

import { ChallengeBanner, OfflineBanner } from "./banners";
import { ConnectionBadge, SyntheticBadge, drillTitle, liveLevel, rosterHref, stageLink } from "./dashboard-view";
import { EventFeed } from "./event-feed";
import { SecureInputBanner } from "./health-pills";
import { agentOffline, type Drill } from "./live-hooks";
import { ModalityBars } from "./modality-bars";
import { TrustChart } from "./trust-chart";
import { TrustGauge } from "./trust-gauge";
import { TtdStopwatch } from "./ttd-stopwatch";
import type { DashboardActions } from "./use-actions";
import { VoiceAnalysis, currentVoiceView } from "./voice-analysis";
import type { VoiceMode } from "./voice-mode";
import { VoiceOutcomeControl } from "./voice-outcome-control";
import { WhyChips } from "./why-chips";

/**
 * `?stage=1` observer layout for the projector laptop (§2.3): big gauge, chart, TTD stopwatch, feed, and big
 * Mark takeover / Reset / Re-arm buttons, so the attacker never signals the system from the monitored laptop.
 * Rendered as a full-screen layer above the site chrome (which goes inert). At xl it fits one screen, 1280x720 and
 * up, with no scrolling: gauge + TTD on the left; chart + feed, then why-chips + per-signal bars on the right. During
 * the voice beat the voice analysis (stages, DSP, findings, decision) replaces the chart and feed; stub results are
 * badged "Simulated voice result". The challenge banner is read-only here: the person at the laptop answers it.
 */
export function StageView({
  state,
  mock,
  actions,
  isAdmin,
  voiceMode,
  drill = null,
}: {
  state: LiveState;
  mock: boolean;
  actions: DashboardActions;
  isAdmin: boolean;
  voiceMode: VoiceMode;
  /** an admin viewing a device from the org console (/dashboard?stage=1&device_id=) */
  drill?: Drill | null;
}) {
  const learning = !state.model || state.model.status !== "ready" || state.device?.mode === "enroll";
  const open = takeoverOpen(state.markers) || state.label === "impostor";
  const { busy } = actions;
  const now = useNow(5000);
  const [hidden, setHidden] = useState<string | null>(null);
  const view = currentVoiceView(state, now);
  const voice = view && `${view.challengeId}:${view.result?.t ?? "scoring"}` !== hidden ? view : null;
  const level = liveLevel(state);
  const scored = scoredModalities(state.model?.enabled_modalities);
  const chartBox = useRef<HTMLDivElement>(null);
  const chartH = useBoxHeight(chartBox, 260, voice !== null);
  useInertChrome();
  const synthetic = !!drill?.row?.synthetic;
  const offline = agentOffline(state, drill, now);

  return (
    <div className="bg-console-grid fixed inset-0 z-50 flex flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center gap-4 border-b bg-background/80 px-4 py-2 backdrop-blur xl:px-5">
        <Wordmark className="text-xl" />
        <span className="hidden text-sm text-muted-foreground md:inline">
          Login proves who you <em>were</em>. 2bME keeps checking who you <em>are</em>.
        </span>
        <div className="ml-auto flex items-center gap-4">
          {synthetic && <SyntheticBadge />}
          <span className="text-sm text-muted-foreground">{drillTitle(drill, state.device?.label) ?? "no device"}</span>
          <ConnectionBadge state={state} mock={mock} />
          <Button asChild variant="ghost" size="icon-sm" aria-label="Exit stage view">
            <Link href={stageLink(mock, state.focus, false)}>
              <X />
            </Link>
          </Button>
        </div>
      </div>

      {/* Everything between the header and the operator bar fits one projector screen at xl (1280x720 and up):
          the chart (or the voice panel) absorbs the spare height, the gauge scales to its box. */}
      <main data-stage-body className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 xl:px-5">
        <SecureInputBanner health={state.health} />
        {offline && <OfflineBanner lastSeen={state.device?.last_seen ?? drill?.row?.last_seen} />}
        <ChallengeBanner challenge={state.open_challenge} compact readOnly />

        <div className="grid gap-3 xl:min-h-0 xl:flex-1 xl:grid-cols-12 xl:grid-rows-[minmax(0,1fr)]">
          <div className="panel flex flex-col gap-3 p-4 xl:col-span-3 xl:min-h-0">
            <div className="flex items-center justify-center xl:min-h-0 xl:flex-1 xl:[container-type:size]">
              <TrustGauge
                trust={state.trust}
                locked={state.device?.locked}
                lockReason={state.device?.lock_reason}
                learning={learning}
                stale={offline}
                size="xl"
                className="max-w-[300px] xl:max-w-[min(420px,100cqw,calc(100cqh_-_1.75rem))]"
              />
            </div>
            {!synthetic && <TtdStopwatch markers={state.markers} history={state.trust_history} blocks={state.blocks} large />}
          </div>

          <div className="flex flex-col gap-3 xl:col-span-9 xl:min-h-0">
            {voice ? (
              <VoiceAnalysis
                view={voice}
                voiceMode={voiceMode}
                large
                className="scrollbar-thin xl:min-h-0 xl:flex-1 xl:overflow-y-auto"
                onDismiss={() => setHidden(`${voice.challengeId}:${voice.result?.t ?? "scoring"}`)}
              />
            ) : (
              <div className="grid gap-3 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.5fr)] xl:grid-rows-[minmax(0,1fr)]">
                <div className="panel flex min-w-0 flex-col overflow-hidden p-4 xl:min-h-0">
                  <div className="eyebrow mb-2 text-xs">Trust · last 10 minutes</div>
                  <div ref={chartBox} className="h-[260px] xl:h-auto xl:min-h-0 xl:flex-1">
                    <TrustChart history={state.trust_history} markers={state.markers} height={chartH} />
                  </div>
                </div>
                <div className="panel flex min-w-0 flex-col overflow-hidden p-4 xl:min-h-0">
                  <div className="eyebrow mb-2 text-xs">Event feed</div>
                  <EventFeed items={state.recent} large className="max-h-[240px] xl:max-h-none xl:min-h-0 xl:flex-1" />
                </div>
              </div>
            )}
            <div className="grid shrink-0 gap-3 lg:grid-cols-2 xl:h-[228px]">
              <div className="panel flex min-h-0 min-w-0 flex-col overflow-hidden p-4">
                <div className="eyebrow mb-2.5 text-xs">Why</div>
                <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pb-2 [mask-image:linear-gradient(to_bottom,black_calc(100%-14px),transparent)]">
                  <WhyChips blocks={state.blocks} level={level} large limit={5} />
                </div>
              </div>
              <div className="panel flex min-h-0 min-w-0 flex-col overflow-hidden p-4">
                <div className="eyebrow mb-2.5 text-xs">Per-signal contribution · last tick</div>
                <ModalityBars trust={state.trust} lastBlocks={state.lastBlocks} level={level} enabled={scored} large />
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* operator controls: their own row under the body, so nothing ever sits beneath them. They drive the demo
          laptop (A); an org employee's device gets the console link instead. */}
      {synthetic && drill ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t bg-background/88 px-4 py-3 text-sm text-muted-foreground backdrop-blur-md xl:px-5">
          <Building2 className="size-4 shrink-0" />
          <span>Synthetic org employee. Admin actions (lock, re-verify, acknowledge) live in the org console.</span>
          <Button asChild variant="outline" size="sm" className="ml-auto">
            <Link href={rosterHref(drill.deviceId)}>Open in the org console</Link>
          </Button>
        </div>
      ) : (
        <div className="shrink-0 border-t bg-background/88 px-4 py-2 backdrop-blur-md xl:px-5">
          <div className="grid grid-cols-3 gap-2 sm:gap-3 xl:grid-cols-[1fr_1fr_1fr_auto] xl:items-center [&>button]:px-2 [&>button]:text-sm sm:[&>button]:text-base max-sm:[&>button>svg]:hidden">
            <Button
              size="lg"
              className={open ? "h-11 bg-muted text-foreground hover:bg-muted/80" : "h-11 bg-trust-suspicious text-white hover:bg-trust-suspicious/85"}
              onClick={() => void actions.setTakeover(!open)}
              disabled={busy === "takeover"}
            >
              {busy === "takeover" ? <Loader2 className="size-5 animate-spin" /> : open ? <FlagOff className="size-5" /> : <Flag className="size-5" />}
              {open ? "End takeover" : "Mark takeover"}
            </Button>
            <Button size="lg" variant="outline" className="h-11" onClick={() => void actions.reset()} disabled={busy === "reset"}>
              {busy === "reset" ? <Loader2 className="size-5 animate-spin" /> : <RotateCcw className="size-5" />}
              Reset demo
            </Button>
            <Button size="lg" variant="outline" className="h-11" onClick={() => void actions.rearm()} disabled={busy === "rearm"}>
              {busy === "rearm" ? <Loader2 className="size-5 animate-spin" /> : <Target className="size-5" />}
              Re-arm (31%)
            </Button>
            {isAdmin && voiceMode === "stub" && (
              <VoiceOutcomeControl
                deviceId={state.device?.id ?? state.focus}
                mock={mock}
                voiceResults={state.voiceResults}
                markers={state.markers}
                bare
                compact
                className="col-span-3 xl:col-span-1"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Height of a box that the layout sizes (the stage chart fills whatever the xl grid leaves it). */
function useBoxHeight(ref: React.RefObject<HTMLDivElement | null>, fallback: number, dep: unknown): number {
  const [h, setH] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setH(Math.max(140, Math.floor(el.getBoundingClientRect().height)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, dep]);
  return h;
}

/** The site nav and status footer sit under this full-screen layer: keep Tab (and screen readers) out of them. */
function useInertChrome() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("header.sticky, footer.fixed"));
    const before = els.map((el) => el.inert);
    for (const el of els) el.inert = true;
    return () => els.forEach((el, i) => (el.inert = before[i]));
  }, []);
}
