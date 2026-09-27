"use client";

import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2 } from "lucide-react";
import { useMemo } from "react";

import type { BlockScored, DeviationOut, Level, Modality } from "@/lib/contracts";
import { alarmLevel, featureMeta, fmtZ, modalityColor, modalityIcon } from "@/lib/ui";
import { cn } from "@/lib/utils";

const RECENT_MS = 45_000;
const RED_Z = 2;

export interface WhyChip extends DeviationOut {
  modality: Modality;
  at: number;
  /** the block this deviation came from counted against the owner (ΔL < 0) */
  against: boolean;
}

/**
 * Strongest recent deviations across block_scored.top (dedup by feature, max |z|). Deviations from blocks
 * that counted against the owner rank first; the rest are context, not alarms.
 */
export function whyChips(blocks: BlockScored[], limit = 8): WhyChip[] {
  if (!blocks.length) return [];
  const latest = Math.max(...blocks.map((b) => Date.parse(b.t_end)));
  const best = new Map<string, WhyChip>();
  for (const b of blocks) {
    const at = Date.parse(b.t_end);
    if (at < latest - RECENT_MS) continue;
    const against = (b.delta ?? 0) < 0;
    for (const d of b.top) {
      const prev = best.get(d.feature);
      const better = !prev || (against && !prev.against) || (against === prev.against && Math.abs(d.z) > Math.abs(prev.z));
      if (better) best.set(d.feature, { ...d, modality: b.modality, at, against });
    }
  }
  return [...best.values()]
    .sort((a, b) => Number(b.against) - Number(a.against) || Math.abs(b.z) - Math.abs(a.z))
    .slice(0, limit);
}

/** Red only while trust is at Watch or below: at Normal every chip is grey context. */
export function redChip(c: Pick<WhyChip, "against" | "z">, level: Level | null | undefined): boolean {
  return alarmLevel(level) && c.against && Math.abs(c.z) >= RED_Z;
}

export function WhyChips({
  blocks,
  level,
  large = false,
  limit = 8,
}: {
  blocks: BlockScored[];
  /** current trust level (locked when the device is locked) */
  level: Level | null | undefined;
  large?: boolean;
  limit?: number;
}) {
  const chips = useMemo(() => whyChips(blocks, limit), [blocks, limit]);
  const anyRed = chips.some((c) => redChip(c, level));

  if (!chips.length) {
    return <p className="py-3 text-sm text-muted-foreground">Waiting for scored blocks…</p>;
  }

  return (
    <div className="space-y-3">
      <div className={cn("flex flex-wrap gap-2", large && "gap-2.5")}>
        <AnimatePresence initial={false} mode="popLayout">
          {chips.map((c) => {
            const red = redChip(c, level);
            const Icon = modalityIcon(c.modality);
            const label = c.label || featureMeta(c.feature)?.label || c.feature;
            return (
              <motion.span
                key={c.feature}
                layout
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.2 }}
                title={`${c.feature} · ${c.unit}`}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                  large && "px-3.5 py-1.5 text-base",
                  red ? "border-trust-suspicious/45 bg-trust-suspicious/12 text-foreground" : "border-border bg-muted/50 text-muted-foreground",
                )}
              >
                <Icon className={cn("size-3", large && "size-4")} style={{ color: modalityColor(c.modality) }} />
                <span>{label}</span>
                <span className={cn("tnum font-mono font-semibold", red ? "text-trust-suspicious" : "text-foreground/80")}>{fmtZ(c.z)}</span>
              </motion.span>
            );
          })}
        </AnimatePresence>
      </div>
      {!anyRed && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="size-3.5 text-trust-normal" /> No recent block counted against the owner; grey chips are normal variation.
        </p>
      )}
    </div>
  );
}
