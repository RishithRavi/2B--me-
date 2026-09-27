"use client";

import { motion } from "framer-motion";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { BlockScored, Level, Modality, TrustLive } from "@/lib/contracts";
import { alarmLevel, fmtAgo, fmtSigned, modalityColor, modalityIcon, modalityLabel, unscoredLabel } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * Signed per-modality contribution to the last trust update (ΔL = κ·w·q·f(llr)).
 * Right of center = evidence for the owner (modality color), left = against (red at Watch or below, grey at Normal).
 */
export function ModalityBars({
  trust,
  lastBlocks,
  level,
  enabled,
  large = false,
}: {
  trust: TrustLive | null;
  lastBlocks: Partial<Record<Modality, BlockScored>>;
  /** current trust level (locked when the device is locked): negative bars are red only when it is not Normal */
  level: Level | null | undefined;
  /** the modalities the model scores (scoredModalities); the rest get one "captured, not scored" line */
  enabled: readonly Modality[];
  large?: boolean;
}) {
  const alarm = alarmLevel(level);
  const per = trust?.per_modality ?? {};
  const maxAbs = Math.max(0.25, ...enabled.map((m) => Math.abs(per[m]?.delta ?? 0)));
  const unscored = unscoredLabel(enabled);

  return (
    <div className={cn("space-y-2.5", large && "space-y-4")}>
      {enabled.map((m) => {
        const c = per[m];
        const Icon = modalityIcon(m);
        const delta = c?.delta ?? null;
        const frac = delta === null ? 0 : Math.min(1, Math.abs(delta) / maxAbs);
        const neg = (delta ?? 0) < 0;
        const barColor = neg ? (alarm ? "var(--trust-suspicious)" : "var(--muted-foreground)") : modalityColor(m);
        const last = lastBlocks[m];
        return (
          <Tooltip key={m}>
            <TooltipTrigger asChild>
              <div className={cn("grid cursor-default grid-cols-[7.5rem_1fr_3.25rem] items-center gap-3", large && "grid-cols-[10rem_1fr_4rem]")}>
                <div className={cn("flex items-center gap-2 text-sm", large && "text-base")}>
                  <Icon className="size-4 shrink-0" style={{ color: modalityColor(m) }} />
                  <span className={cn("truncate", !c && "text-muted-foreground")}>{modalityLabel(m, true)}</span>
                </div>
                <div className={cn("relative h-2.5 rounded-full bg-muted", large && "h-4")}>
                  <div className="absolute inset-y-[-3px] left-1/2 w-px bg-foreground/25" />
                  {delta !== null && (
                    <motion.div
                      className="absolute inset-y-0 rounded-full"
                      style={{ background: barColor, [neg ? "right" : "left"]: "50%" }}
                      initial={false}
                      animate={{ width: `${Math.max(frac * 50, 1.5)}%` }}
                      transition={{ type: "spring", stiffness: 120, damping: 20 }}
                    />
                  )}
                </div>
                <div className={cn("tnum text-right font-mono text-xs", large && "text-sm", delta === null || (neg && !alarm) ? "text-muted-foreground" : neg ? "text-trust-suspicious" : "text-foreground")}>
                  {delta === null ? "—" : fmtSigned(delta)}
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs">
              <div className="space-y-1 text-xs">
                <div className="font-medium">{modalityLabel(m)}</div>
                {c ? (
                  <div className="tnum grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono">
                    <span className="opacity-70">ΔL</span>
                    <span>{fmtSigned(c.delta, 3)}</span>
                    <span className="opacity-70">typicality</span>
                    <span>{c.typicality === null ? "—" : c.typicality.toFixed(2)}</span>
                    <span className="opacity-70">LLR</span>
                    <span>{fmtSigned(c.llr)}</span>
                    <span className="opacity-70">evidence q · weight w</span>
                    <span>
                      {c.q.toFixed(2)} · {c.w.toFixed(2)}
                    </span>
                    <span className="opacity-70">blocks this tick</span>
                    <span>{c.n_blocks}</span>
                  </div>
                ) : (
                  <div className="opacity-80">No {modalityLabel(m, true).toLowerCase()} evidence in the last tick — missing, not anomalous.</div>
                )}
                {last && <div className="opacity-70">last block {fmtAgo(last.t_end)} · n={last.n}</div>}
              </div>
            </TooltipContent>
          </Tooltip>
        );
      })}
      <div className={cn("flex justify-between pt-1 pl-[8.25rem] text-[10px] text-muted-foreground", large && "pl-[11rem] text-xs")}>
        <span>← against owner</span>
        <span>for owner →</span>
      </div>
      {unscored && <p className={cn("text-[11px] text-muted-foreground/70", large && "text-xs")}>{unscored}: captured, not scored by this model</p>}
    </div>
  );
}
