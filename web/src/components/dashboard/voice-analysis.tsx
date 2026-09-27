"use client";

// Voice analysis for the observer screen (stage view) and the dashboard: when a voice_result arrives, the four
// stage outcomes (Words, Speaker ASV cosine, Anti-spoof p(spoof), Spectral similarity), the DSP/FFT values, the
// findings and a decision banner. Stub voice results carry a "Simulated voice result" badge (§8 C2).
import { motion } from "framer-motion";
import { AudioLines, Check, CircleDashed, FlaskConical, Loader2, Minus, ShieldCheck, ShieldX, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { VoiceStageLive } from "@/lib/contracts";
import type { LiveState, LiveVoiceResult } from "@/lib/live";
import { fmtClock, shortId } from "@/lib/ui";
import { cn } from "@/lib/utils";

import { DECISION_META, dspRows, isSimulated, lastResetAt, scoringMs, stageTiles, type StageTile } from "./voice-format";
import type { VoiceMode } from "./voice-mode";

/** Amber badge: this voice result came from the stub pipeline (canned or chosen by the operator). */
export function SimulatedBadge({ large = false, className }: { large?: boolean; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex shrink-0 cursor-default items-center gap-1.5 rounded-full border border-trust-watch/50 bg-trust-watch/12 px-2.5 py-0.5 text-xs font-medium text-trust-watch",
            large && "px-3 py-1 text-sm",
            className,
          )}
        >
          <FlaskConical className={cn("size-3.5", large && "size-4")} /> Simulated voice result
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Stub voice mode: this result is canned or chosen by the operator. It is not a live analysis of the recorded audio.
      </TooltipContent>
    </Tooltip>
  );
}

export interface VoiceView {
  challengeId: string;
  result: LiveVoiceResult | null;
  stages: VoiceStageLive[];
}

const MAX_AGE_MS = 10 * 60 * 1000;

/** A voice result older than the latest Reset, Re-arm or takeover start belongs to an earlier run of the story. */
function voiceCutoff(markers: LiveState["markers"]): number {
  let t = lastResetAt(markers);
  for (const m of markers) if (m.label === "rearm" || m.label === "takeover_start") t = Math.max(t, Date.parse(m.t));
  return t;
}

/**
 * What the voice panel shows right now: a check being scored on the open challenge (live stages, no result yet),
 * else the newest voice result since the last Reset / Re-arm / takeover start (≤ 10 min old), else nothing.
 */
export function currentVoiceView(
  s: Pick<LiveState, "voiceResults" | "voiceStages" | "open_challenge" | "markers">,
  now: number = Date.now(),
): VoiceView | null {
  const resetAt = voiceCutoff(s.markers);
  const latest = s.voiceResults[0] ?? null;
  const at = latest ? Date.parse(latest.t) : NaN;
  const fresh = latest && at > resetAt && now - at < MAX_AGE_MS ? latest : null;
  const oc = s.open_challenge;
  if (oc) {
    const stages = s.voiceStages[oc.challenge_id] ?? [];
    const scoring = oc.status === "scoring" || (stages.length > 0 && !stages.some((x) => x.stage === "done"));
    if (scoring && (!fresh || fresh.challenge_id !== oc.challenge_id || oc.status === "scoring")) {
      return { challengeId: oc.challenge_id, result: null, stages };
    }
  }
  if (fresh) return { challengeId: fresh.challenge_id, result: fresh, stages: s.voiceStages[fresh.challenge_id] ?? [] };
  return null;
}

function Tile({ t, large }: { t: StageTile; large: boolean }) {
  const color = t.pending ? "var(--muted-foreground)" : t.ok === false ? "var(--trust-suspicious)" : t.ok ? "var(--trust-normal)" : "var(--trust-watch)";
  const Icon = t.pending ? CircleDashed : t.ok === false ? X : t.ok ? Check : Minus;
  const frac = t.value === null ? 0 : Math.max(0, Math.min(1, t.value));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn("cursor-default rounded-xl border bg-card/60 px-3 py-2.5", large && "px-4 py-3")}
          style={{ borderColor: t.pending ? undefined : `color-mix(in oklch, ${color} 45%, transparent)` }}
        >
          <div className="flex items-center gap-2">
            <span className="grid size-6 shrink-0 place-items-center rounded-full" style={{ background: `color-mix(in oklch, ${color} 18%, transparent)`, color }}>
              <Icon className="size-3.5" />
            </span>
            <span className={cn("font-medium", large ? "text-base" : "text-sm")}>{t.label}</span>
            <span className={cn("ml-auto text-muted-foreground", large ? "text-xs" : "text-[11px]")}>{t.metric}</span>
          </div>
          <div className={cn("tnum mt-1.5 font-mono font-semibold", large ? "text-3xl" : "text-2xl")} style={{ color: t.pending ? "var(--muted-foreground)" : color }}>
            {t.value === null ? "—" : t.value.toFixed(2)}
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
            <motion.div className="h-full rounded-full" style={{ background: color }} initial={false} animate={{ width: `${frac * 100}%` }} transition={{ duration: 0.4 }} />
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent>{t.hint}</TooltipContent>
    </Tooltip>
  );
}

export function VoiceAnalysis({
  view,
  voiceMode,
  large = false,
  onDismiss,
  className,
}: {
  view: VoiceView;
  voiceMode: VoiceMode;
  large?: boolean;
  onDismiss?: () => void;
  className?: string;
}) {
  const r = view.result;
  const tiles = stageTiles(r, view.stages);
  const meta = r ? DECISION_META[r.decision] : null;
  const simulated = isSimulated(r, voiceMode);
  const rows = dspRows(r?.dsp);
  const total = scoringMs(r?.stage_ms);
  const ms = total !== null && total >= 100 ? total : null; // a canned stub result "scores" in ~0 ms: don't show it
  const BannerIcon = !meta ? Loader2 : meta.tone === "ok" ? ShieldCheck : meta.tone === "block" ? ShieldX : TriangleAlert;

  return (
    <motion.section
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("panel flex flex-col gap-3.5 p-4", large && "gap-4 p-5", className)}
      aria-label="Voice analysis"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <AudioLines className={cn("size-4 text-muted-foreground", large && "size-5")} />
        <h2 className={cn("font-medium", large ? "text-base" : "text-sm")}>Voice analysis</h2>
        <span className="font-mono text-xs text-muted-foreground">
          challenge {shortId(view.challengeId)}
          {r ? ` · ${fmtClock(r.t)}` : ""}
          {ms !== null ? ` · scored in ${(ms / 1000).toFixed(1)} s` : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {simulated && <SimulatedBadge large={large} />}
          {onDismiss && (
            <Button variant="ghost" size="icon-sm" aria-label="Hide voice analysis" onClick={onDismiss}>
              <X />
            </Button>
          )}
        </div>
      </header>

      {/* decision banner */}
      <div
        className={cn("flex items-center gap-3 rounded-xl border px-4 py-3", large && "px-5 py-4")}
        style={
          meta
            ? { borderColor: `color-mix(in oklch, ${meta.color} 50%, transparent)`, background: `color-mix(in oklch, ${meta.color} 12%, transparent)` }
            : undefined
        }
        role={meta?.tone === "block" ? "alert" : "status"}
      >
        <BannerIcon className={cn("shrink-0", large ? "size-8" : "size-6", !meta && "animate-spin text-muted-foreground")} style={meta ? { color: meta.color } : undefined} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3">
            {r && (
              <span className={cn("font-mono font-bold tracking-tight", large ? "text-3xl" : "text-xl")} style={{ color: meta?.color }}>
                {r.decision}
              </span>
            )}
            <span className={cn("font-semibold", large ? "text-xl" : "text-base")}>{meta ? meta.label : "Scoring the reply…"}</span>
          </div>
          <div className={cn("text-muted-foreground", large ? "text-sm" : "text-xs")}>
            {meta ? meta.sub : "Words, speaker, anti-spoof and spectral checks run in parallel on the server; the audio is deleted after scoring."}
          </div>
        </div>
        {r && (
          <div className="shrink-0 text-right">
            <div className="text-[11px] text-muted-foreground">voice confidence</div>
            <div className={cn("tnum font-mono font-semibold", large ? "text-2xl" : "text-lg")}>{r.voice_confidence.toFixed(2)}</div>
          </div>
        )}
      </div>

      {/* stage outcomes */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {tiles.map((t) => (
          <Tile key={t.key} t={t} large={large} />
        ))}
      </div>

      {/* DSP / FFT + findings */}
      {r && (rows.length > 0 || r.findings.length > 0) && (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl bg-muted/35 px-3.5 py-3">
            <div className="eyebrow mb-2 text-[11px]">DSP / FFT features</div>
            {rows.length ? (
              <dl className={cn("grid grid-cols-[1fr_auto] gap-x-4 gap-y-1", large ? "text-sm" : "text-[13px]")}>
                {rows.map((d) => (
                  <div key={d.key} className="contents">
                    <dt className="truncate text-muted-foreground" title={d.hint}>
                      {d.label}
                    </dt>
                    <dd className="tnum text-right font-mono">{d.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-xs text-muted-foreground">No DSP values in this result.</p>
            )}
          </div>
          <div className="rounded-xl bg-muted/35 px-3.5 py-3">
            <div className="eyebrow mb-2 text-[11px]">Findings</div>
            {r.findings.length ? (
              <ul className={cn("space-y-1.5", large ? "text-sm" : "text-[13px]")}>
                {r.findings.map((f, i) => (
                  <li key={`${i}:${f}`} className="flex gap-2">
                    <span className="mt-[7px] size-1.5 shrink-0 rounded-full" style={{ background: meta?.color ?? "var(--muted-foreground)" }} />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No findings: nothing stood out.</p>
            )}
          </div>
        </div>
      )}
    </motion.section>
  );
}
