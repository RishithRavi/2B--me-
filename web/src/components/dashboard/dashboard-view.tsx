"use client";

import { Activity, ArrowLeft, AudioWaveform, BarChart3, Building2, Fingerprint, Laptop, ListTree, MonitorPlay, Sparkles } from "lucide-react";
import Link from "next/link";

import { Dot } from "@/components/site/empty-state";
import { Panel } from "@/components/site/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Level } from "@/lib/contracts";
import { useNow } from "@/lib/hooks";
import type { LiveState, LiveStore } from "@/lib/live";
import { takeoverOpen } from "@/lib/ttd";
import { fmtAgo, scoredModalities, shortId } from "@/lib/ui";
import { cn } from "@/lib/utils";

import { ChallengeBanner, DevicePicker, LockedBanner, OfflineBanner } from "./banners";
import { Controls } from "./controls";
import { EventFeed } from "./event-feed";
import { HealthPills, SecureInputBanner } from "./health-pills";
import { IdentityCard } from "./identity-card";
import { agentOffline, type Drill } from "./live-hooks";
import { ModalityBars } from "./modality-bars";
import { SpectrumPanel } from "./spectrum-panel";
import { TickDrawer } from "./tick-drawer";
import { TrustChart } from "./trust-chart";
import { TrustGauge } from "./trust-gauge";
import { TtdStopwatch } from "./ttd-stopwatch";
import type { DashboardActions } from "./use-actions";
import { VoiceAnalysis, currentVoiceView } from "./voice-analysis";
import type { VoiceMode } from "./voice-mode";
import { WhyChips } from "./why-chips";

export function ConnectionBadge({ state, mock }: { state: LiveState; mock: boolean }) {
  if (mock)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-trust-watch">
        <Dot color="var(--trust-watch)" pulse /> simulated stream
      </span>
    );
  if (state.connected)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-trust-normal">
        <Dot color="var(--trust-normal)" pulse /> live
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-trust-watch">
      <Dot color="var(--trust-watch)" /> {state.closeCode === 4401 ? "sign in required" : "reconnecting…"}
    </span>
  );
}

/** The level the why-chips and modality bars key their alarm color on: Locked while the device is locked. */
export function liveLevel(state: Pick<LiveState, "device" | "trust">): Level | null {
  if (state.device?.locked || state.trust?.locked) return "locked";
  return state.trust?.level ?? null;
}

/** Header title for a drill-in: a synthetic org employee is named by handle and team, anything else by device label. */
export function drillTitle(drill: Drill | null | undefined, deviceLabel: string | null | undefined): string | null {
  const row = drill?.row;
  if (row?.synthetic) return row.team ? `${row.handle} · ${row.team}` : row.handle;
  return deviceLabel ?? null;
}

/** Amber tag on org-demo employees: simulated behavior, never a real person (§0.3). */
export function SyntheticBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("border-trust-watch/50 font-mono text-[10px] uppercase text-trust-watch", className)}
      title="Org-demo employee: simulated behavior streamed by the demo engine, not a real person"
    >
      synthetic
    </Badge>
  );
}

/** Link back to this device's drawer in the org console. */
export const rosterHref = (deviceId: string) => `/admin?device_id=${encodeURIComponent(deviceId)}`;

/** Stage view link that keeps the admin's drill-in device (?device_id=). */
export function stageLink(mock: boolean, deviceId: string | null, stage = true): string {
  const q = new URLSearchParams();
  if (stage) q.set("stage", "1");
  if (deviceId && !mock) q.set("device_id", deviceId);
  if (mock) q.set("mock", "1");
  const s = q.toString();
  return s ? `/dashboard?${s}` : "/dashboard";
}

export function DashboardView({
  state,
  store,
  mock,
  actions,
  isAdmin,
  voiceMode,
  serverBackend = null,
  drill = null,
}: {
  state: LiveState;
  store: LiveStore | null;
  mock: boolean;
  actions: DashboardActions;
  isAdmin: boolean;
  voiceMode: VoiceMode;
  /** the server's scorer (StatusOut) — the identity card's fallback when ModelInfo.backend is empty */
  serverBackend?: string | null;
  /** an admin viewing a device from the org console (/dashboard?device_id=) */
  drill?: Drill | null;
}) {
  const learning = !state.model || state.model.status !== "ready" || state.device?.mode === "enroll";
  const now = useNow(5000);
  const voice = currentVoiceView(state, now);
  const stageHref = stageLink(mock, state.focus);
  const level = liveLevel(state);
  const scored = scoredModalities(state.model?.enabled_modalities);
  const synthetic = !!drill?.row?.synthetic;
  const offline = agentOffline(state, drill, now);
  const whose = drill ? "this employee's" : "your";

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-4 px-4 py-5 sm:px-6">
      {/* header */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted ring-1 ring-foreground/10">
            <Laptop className="size-5 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-semibold tracking-tight">{drillTitle(drill, state.device?.label) ?? "Waiting for a device…"}</h1>
              {synthetic && <SyntheticBadge />}
              {state.device && (
                <Badge variant="outline" className="font-mono text-[10px] uppercase">
                  {state.device.mode}
                </Badge>
              )}
              {/* the A/B ground-truth label belongs to the demo laptop; org employees don't carry one */}
              {!synthetic && (
                <Badge
                  variant="outline"
                  className={cn(
                    "font-mono text-[10px] uppercase",
                    state.label === "impostor" ? "border-trust-suspicious/50 text-trust-suspicious" : "text-muted-foreground",
                  )}
                  title="Ground-truth label (for eval only; never scored)"
                >
                  {state.label} · {state.actor}
                </Badge>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
              <ConnectionBadge state={state} mock={mock} />
              {synthetic && state.device?.label && <span>{state.device.label}</span>}
              <span className="font-mono">session {shortId(state.session_id)}</span>
              {state.device?.pointer && <span>{state.device.pointer}</span>}
              {state.device?.last_seen && <span>seen {fmtAgo(state.device.last_seen)}</span>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          {drill && (
            <Button asChild variant="outline" size="sm">
              <Link href={rosterHref(drill.deviceId)}>
                <ArrowLeft /> Back to roster
              </Link>
            </Button>
          )}
          <DevicePicker devices={state.knownDevices} current={state.focus} onPick={(id) => store?.setFocus(id)} />
          <TickDrawer tick={state.last_tick_json} onRefresh={() => store?.reconnect()} />
          <Button asChild variant="ghost" size="sm">
            <Link href={stageHref}>
              <MonitorPlay /> Stage view
            </Link>
          </Button>
        </div>
      </div>

      <SecureInputBanner health={state.health} />
      {offline && <OfflineBanner lastSeen={state.device?.last_seen ?? drill?.row?.last_seen} />}
      <LockedBanner device={state.device} onUnlock={() => void actions.unlockWithVoice()} busy={actions.busy === "unlock"} readOnly={synthetic} />
      <ChallengeBanner challenge={state.open_challenge} readOnly={!!drill} />
      {voice && <VoiceAnalysis view={voice} voiceMode={voiceMode} />}

      {/* operator controls + health */}
      <div className="panel space-y-3 px-4 py-3">
        {synthetic && drill ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
            <Building2 className="size-4 shrink-0" />
            <span>Admin actions (lock, re-verify, acknowledge) live in the org console.</span>
            <Button asChild variant="outline" size="sm" className="ml-auto">
              <Link href={rosterHref(drill.deviceId)}>Open in the org console</Link>
            </Button>
          </div>
        ) : (
          <Controls device={state.device} model={state.model} label={state.label} actions={actions} isAdmin={isAdmin} />
        )}
        <div className="border-t pt-3">
          <HealthPills health={state.health} healthAt={state.healthAt} presence={state.presence} enabled={scored} voiceMode={voiceMode} />
        </div>
      </div>

      {/* row 1: gauge + chart */}
      <div className="grid gap-4 lg:grid-cols-12">
        <Panel title="Trust" icon={Activity} className="lg:col-span-4" bodyClassName="space-y-4">
          <TrustGauge trust={state.trust} locked={state.device?.locked} lockReason={state.device?.lock_reason} learning={learning} stale={offline} />
          {/* time-to-detection runs off the demo laptop's takeover markers; org employees have none */}
          {!synthetic && (
            <TtdStopwatch
              markers={state.markers}
              history={state.trust_history}
              blocks={state.blocks}
              open={takeoverOpen(state.markers) || state.label === "impostor"}
            />
          )}
        </Panel>
        <Panel title="Last 10 minutes" icon={BarChart3} hint="bands at 80% and 40% · takeover shaded" className="lg:col-span-8">
          <TrustChart history={state.trust_history} markers={state.markers} height={392} />
        </Panel>
      </div>

      {/* row 2: contributions + why + feed */}
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="grid gap-4 lg:col-span-8 lg:grid-cols-2">
          <Panel title="Per-modality contribution" icon={Fingerprint} hint="last tick, ΔL">
            <ModalityBars trust={state.trust} lastBlocks={state.lastBlocks} level={level} enabled={scored} />
          </Panel>
          <Panel title="Why" icon={Sparkles} hint={`largest deviations from ${whose} profile`}>
            <WhyChips blocks={state.blocks} level={level} />
          </Panel>
          <Panel title="Identity" icon={Fingerprint} hint={drill ? "what 2bME has learned about this employee" : "what 2bME has learned about you"}>
            <IdentityCard
              model={state.model}
              enroll={state.enroll}
              lastTick={state.last_tick_json}
              context={state.context}
              serverBackend={serverBackend}
            />
          </Panel>
          <Panel title="Rhythm spectrum (FFT)" icon={AudioWaveform} hint="input-event timing, 0–25 Hz">
            <SpectrumPanel context={state.context} enrolledPsd={state.enrolled_psd} />
          </Panel>
        </div>
        <Panel title="Event feed" icon={ListTree} className="lg:col-span-4" bodyClassName="flex flex-col">
          <EventFeed items={state.recent} className="max-h-[820px] min-h-[240px] flex-1" />
        </Panel>
      </div>
    </div>
  );
}
