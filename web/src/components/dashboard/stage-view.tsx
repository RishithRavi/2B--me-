"use client";

import { Flag, FlagOff, Loader2, RotateCcw, Target, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Wordmark } from "@/components/site/logo";
import { Button } from "@/components/ui/button";
import { useNow } from "@/lib/hooks";
import type { LiveState } from "@/lib/live";
import { takeoverOpen } from "@/lib/ttd";

import { ChallengeBanner } from "./banners";
import { ConnectionBadge, liveLevel, stageLink } from "./dashboard-view";
import { EventFeed } from "./event-feed";
import { SecureInputBanner } from "./health-pills";
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
 * Rendered as a full-screen overlay above the site chrome. During the voice beat the voice analysis (stages, DSP,
 * findings, decision) takes the top of the right column; stub results are badged "Simulated voice result".
 */
export function StageView({
  state,
  mock,
  actions,
  isAdmin,
  voiceMode,
}: {
  state: LiveState;
  mock: boolean;
  actions: DashboardActions;
  isAdmin: boolean;
  voiceMode: VoiceMode;
}) {
  const learning = !state.model || state.model.status !== "ready" || state.device?.mode === "enroll";
  const open = takeoverOpen(state.markers) || state.label === "impostor";
  const { busy } = actions;
  const now = useNow(5000);
  const [hidden, setHidden] = useState<string | null>(null);
  const view = currentVoiceView(state, now);
  const voice = view && `${view.challengeId}:${view.result?.t ?? "scoring"}` !== hidden ? view : null;
  const level = liveLevel(state);

  return (
    <div className="bg-console-grid fixed inset-0 z-50 flex flex-col overflow-auto bg-background">
      <div className="flex items-center gap-4 border-b bg-background/80 px-6 py-3 backdrop-blur">
        <Wordmark className="text-xl" />
        <span className="hidden text-sm text-muted-foreground md:inline">
          Login proves who you <em>were</em>. 2bME keeps checking who you <em>are</em>.
        </span>
        <div className="ml-auto flex items-center gap-4">
          <span className="text-sm text-muted-foreground">{state.device?.label ?? "no device"}</span>
          <ConnectionBadge state={state} mock={mock} />
          <Button asChild variant="ghost" size="icon-sm" aria-label="Exit stage view">
            <Link href={stageLink(mock, state.focus, false)}>
              <X />
            </Link>
          </Button>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-5 p-6">
        <SecureInputBanner health={state.health} />
        <ChallengeBanner challenge={state.open_challenge} large />

        <div className="grid flex-1 gap-5 xl:grid-cols-12">
          <div className="panel flex flex-col gap-5 p-6 xl:col-span-4">
            <TrustGauge trust={state.trust} locked={state.device?.locked} lockReason={state.device?.lock_reason} learning={learning} size="xl" />
            <TtdStopwatch markers={state.markers} history={state.trust_history} blocks={state.blocks} large />
          </div>
          <div className="flex flex-col gap-5 xl:col-span-8">
            {voice && (
              <VoiceAnalysis
                view={voice}
                voiceMode={voiceMode}
                large
                onDismiss={() => setHidden(`${voice.challengeId}:${voice.result?.t ?? "scoring"}`)}
              />
            )}
            <div className="panel p-5">
              <div className="eyebrow mb-2 text-xs">Trust · last 10 minutes</div>
              <TrustChart history={state.trust_history} markers={state.markers} height={voice ? 240 : 360} />
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="panel p-5">
                <div className="eyebrow mb-3 text-xs">Why</div>
                <WhyChips blocks={state.blocks} level={level} large limit={6} />
                <div className="mt-5">
                  <ModalityBars trust={state.trust} lastBlocks={state.lastBlocks} level={level} large />
                </div>
              </div>
              <div className="panel flex flex-col p-5">
                <div className="eyebrow mb-2 text-xs">Event feed</div>
                <EventFeed items={state.recent} large className="max-h-[360px] flex-1" />
              </div>
            </div>
          </div>
        </div>

        {/* operator controls stay on screen (sticky) however tall the voice beat makes the page */}
        <div className="sticky bottom-0 z-10 -mx-6 -mb-6 mt-auto space-y-2.5 border-t bg-background/88 px-6 py-3.5 backdrop-blur-md">
          <div className="grid gap-4 sm:grid-cols-3">
            <Button
              size="lg"
              className={open ? "h-14 bg-muted text-lg text-foreground hover:bg-muted/80" : "h-14 bg-trust-suspicious text-lg text-white hover:bg-trust-suspicious/85"}
              onClick={() => void actions.setTakeover(!open)}
              disabled={busy === "takeover"}
            >
              {busy === "takeover" ? <Loader2 className="size-5 animate-spin" /> : open ? <FlagOff className="size-5" /> : <Flag className="size-5" />}
              {open ? "End takeover" : "Mark takeover"}
            </Button>
            <Button size="lg" variant="outline" className="h-14 text-lg" onClick={() => void actions.reset()} disabled={busy === "reset"}>
              {busy === "reset" ? <Loader2 className="size-5 animate-spin" /> : <RotateCcw className="size-5" />}
              Reset demo
            </Button>
            <Button size="lg" variant="outline" className="h-14 text-lg" onClick={() => void actions.rearm()} disabled={busy === "rearm"}>
              {busy === "rearm" ? <Loader2 className="size-5 animate-spin" /> : <Target className="size-5" />}
              Re-arm (31%)
            </Button>
          </div>
          {isAdmin && voiceMode === "stub" && (
            <VoiceOutcomeControl deviceId={state.device?.id ?? state.focus} mock={mock} voiceResults={state.voiceResults} markers={state.markers} bare />
          )}
        </div>
      </div>
    </div>
  );
}
