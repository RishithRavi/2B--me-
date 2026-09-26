"use client";

import { Timer, TimerOff, TimerReset } from "lucide-react";
import { useMemo } from "react";

import type { BlockScored, MarkerPoint, TrustPoint } from "@/lib/contracts";
import { useNow } from "@/lib/hooks";
import { computeTtd } from "@/lib/ttd";
import { fmtPct } from "@/lib/ui";
import { cn } from "@/lib/utils";

function clock(seconds: number | null): string {
  if (seconds === null) return "00:00.0";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

/**
 * Time-to-detection: runs from the latest takeover_start marker to the first trust tick below 0.40,
 * then freezes at "Detected in N s (M keyboard, K mouse blocks)".
 */
export function TtdStopwatch({
  markers,
  history,
  blocks,
  large = false,
}: {
  markers: MarkerPoint[];
  history: TrustPoint[];
  blocks: BlockScored[];
  large?: boolean;
}) {
  // Only tick fast while the stopwatch is actually running.
  const running = useMemo(() => computeTtd(markers, history, blocks).status === "running", [markers, history, blocks]);
  const now = useNow(running ? 100 : 0);
  const r = useMemo(() => computeTtd(markers, history, blocks, now), [markers, history, blocks, now]);

  const kb = r.counts.keyboard ?? 0;
  const ms = r.counts.mouse ?? 0;
  const color =
    r.status === "detected" ? "var(--trust-suspicious)" : r.status === "running" ? "var(--trust-watch)" : "var(--muted-foreground)";
  const Icon = r.status === "detected" ? Timer : r.status === "running" ? Timer : r.status === "ended" ? TimerOff : TimerReset;

  return (
    <div
      className={cn("rounded-xl border p-3", large && "p-5")}
      style={{ borderColor: `color-mix(in oklch, ${color} 35%, transparent)`, background: `color-mix(in oklch, ${color} 6%, transparent)` }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cn("eyebrow", large && "text-xs")}>Time to detection</span>
        <Icon className={cn("size-4", r.status === "running" && "animate-pulse")} style={{ color }} />
      </div>
      <div className={cn("tnum mt-1 font-mono font-semibold tracking-tight", large ? "text-6xl" : "text-3xl")} style={{ color: r.status === "idle" ? undefined : color }}>
        {clock(r.seconds)}
      </div>
      <div className={cn("mt-1 text-muted-foreground", large ? "text-base" : "text-xs")}>
        {r.status === "idle" && "Waiting for a takeover marker (Mark takeover / ⌃⌥⌘M)."}
        {r.status === "running" && (
          <>
            B at the keyboard · {kb} keyboard, {ms} mouse blocks scored so far
          </>
        )}
        {r.status === "detected" && (
          <span className="text-foreground">
            Detected in <b className="tnum">{Math.round(r.seconds ?? 0)} s</b> ({kb} keyboard, {ms} mouse blocks) · trust {fmtPct(r.confidence)}
          </span>
        )}
        {r.status === "ended" && <>Takeover ended before trust fell below 40%.</>}
      </div>
    </div>
  );
}
