"use client";

import { Timer, TimerOff, TimerReset } from "lucide-react";
import { useMemo, useRef } from "react";

import type { BlockScored, MarkerPoint, TrustPoint } from "@/lib/contracts";
import { useNow } from "@/lib/hooks";
import { DETECT_THRESHOLD, computeTtd, latestTakeoverStart, type TtdResult } from "@/lib/ttd";
import { fmtPct } from "@/lib/ui";
import { cn } from "@/lib/utils";

function clock(seconds: number | null): string {
  if (seconds === null) return "00:00.0";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

const ms = (iso: string) => Date.parse(iso);

/** What the stopwatch shows: computeTtd, plus whether its block counts can be trusted and pre-load detection. */
export interface TtdView {
  r: TtdResult;
  /** the scored blocks on hand start before the takeover marker, so the counts are complete */
  countsComplete: boolean;
  /** the takeover was already detected when this page's trust history begins (reload, or a long takeover) */
  beforeLoad: boolean;
}

/** Pure: TTD view over the current window (no freezing). */
export function ttdView(markers: MarkerPoint[], history: TrustPoint[], blocks: BlockScored[], now: number): TtdView {
  const r = computeTtd(markers, history, blocks, now);
  const firstBlock = blocks.reduce((min, b) => Math.min(min, ms(b.t_end)), Infinity);
  const countsComplete = r.start !== null && Number.isFinite(firstBlock) && firstBlock <= r.start;
  let beforeLoad = false;
  if (r.status === "detected" && r.start !== null) {
    const first = history.reduce<TrustPoint | null>((a, p) => (!a || ms(p.t) < ms(a.t) ? p : a), null);
    beforeLoad = !!first && ms(first.t) > r.start && first.confidence < DETECT_THRESHOLD;
  }
  return { r, countsComplete, beforeLoad };
}

/**
 * Time-to-detection: runs from the latest takeover_start marker to the first trust tick below 0.40, then freezes at
 * "Detected in N s (M keyboard, K mouse blocks)". The first detection for a start marker is kept for as long as that
 * marker is the latest one, so the rolling 10-minute window (trimmed history and blocks) can't move it later.
 */
export function TtdStopwatch({
  markers,
  history,
  blocks,
  large = false,
  open = false,
}: {
  markers: MarkerPoint[];
  history: TrustPoint[];
  blocks: BlockScored[];
  large?: boolean;
  /** a takeover is in progress (the label says impostor) even if its start marker is older than this page's data */
  open?: boolean;
}) {
  const startT = latestTakeoverStart(markers)?.t ?? null;
  const frozen = useRef<{ start: string; v: TtdView } | null>(null);
  if (frozen.current && frozen.current.start !== startT) frozen.current = null;

  // Only tick fast while the stopwatch is actually running.
  const running = !frozen.current && computeTtd(markers, history, blocks).status === "running";
  const now = useNow(running ? 100 : 0);
  const live = useMemo(() => ttdView(markers, history, blocks, now), [markers, history, blocks, now]);
  if (!frozen.current && startT && live.r.status === "detected") frozen.current = { start: startT, v: live };
  const { r, countsComplete, beforeLoad } = frozen.current?.v ?? live;

  const kb = r.counts.keyboard ?? 0;
  const mouse = r.counts.mouse ?? 0;
  const showCounts = countsComplete && kb + mouse > 0;
  const color =
    r.status === "detected" ? "var(--trust-suspicious)" : r.status === "running" ? "var(--trust-watch)" : "var(--muted-foreground)";
  const Icon = r.status === "detected" ? Timer : r.status === "running" ? Timer : r.status === "ended" ? TimerOff : TimerReset;

  return (
    <div
      className={cn("rounded-xl border p-3", large && "p-4")}
      style={{ borderColor: `color-mix(in oklch, ${color} 35%, transparent)`, background: `color-mix(in oklch, ${color} 6%, transparent)` }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cn("eyebrow", large && "text-xs")}>Time to detection</span>
        <Icon className={cn("size-4", r.status === "running" && "animate-pulse")} style={{ color }} />
      </div>
      <div
        className={cn("tnum mt-1 font-mono font-semibold tracking-tight", large ? "text-[clamp(2.5rem,4vw,3.75rem)] leading-tight" : "text-3xl")}
        style={{ color: r.status === "idle" ? undefined : color }}
      >
        {beforeLoad ? "--:--.-" : clock(r.seconds)}
      </div>
      <div className={cn("mt-1 text-muted-foreground", large ? "text-base" : "text-xs")}>
        {r.status === "idle" &&
          (open ? "Takeover in progress; its start marker is older than this page's 10-minute window." : "Waiting for a takeover marker (Mark takeover, or ⌃⌥⌘M on A's Mac).")}
        {r.status === "running" && (
          <>
            B at the keyboard
            {countsComplete && (
              <>
                {" "}
                · {kb} keyboard, {mouse} mouse blocks scored so far
              </>
            )}
          </>
        )}
        {r.status === "detected" &&
          (beforeLoad ? (
            <span className="text-foreground">
              Detected before this page loaded · trust {fmtPct(r.confidence)}
            </span>
          ) : (
            <span className="text-foreground">
              Detected in <b className="tnum">{Math.round(r.seconds ?? 0)} s</b>
              {showCounts && ` (${kb} keyboard, ${mouse} mouse blocks)`} · trust {fmtPct(r.confidence)}
            </span>
          ))}
        {r.status === "ended" && <>Takeover ended before trust fell below 40%.</>}
      </div>
    </div>
  );
}
