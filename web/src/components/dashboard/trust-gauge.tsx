"use client";

import { motion } from "framer-motion";
import { GraduationCap, Lock } from "lucide-react";

import type { Level, TrustLive } from "@/lib/contracts";
import { TRUST_CONFIG } from "@/lib/contracts";
import { levelColor, levelLabel } from "@/lib/ui";
import { cn } from "@/lib/utils";

const START = 135; // degrees (0 = 3 o'clock, clockwise)
const SWEEP = 270;
const R = 84;
const C = 100;

function polar(deg: number, r = R) {
  const rad = (deg * Math.PI) / 180;
  // Round: Node and the browser disagree in the last float digits → hydration mismatch.
  const round = (v: number) => Math.round(v * 100) / 100;
  return { x: round(C + r * Math.cos(rad)), y: round(C + r * Math.sin(rad)) };
}

function arc(from: number, to: number, r = R) {
  const a = polar(START + SWEEP * from, r);
  const b = polar(START + SWEEP * to, r);
  const large = SWEEP * (to - from) > 180 ? 1 : 0;
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} 1 ${b.x} ${b.y}`;
}

const FULL = arc(0, 1);

export interface TrustGaugeProps {
  trust: TrustLive | null;
  /** device lock flag (sticky) — overrides the level */
  locked?: boolean;
  /** true when there is no trained model / enroll mode */
  learning?: boolean;
  size?: "md" | "xl";
  className?: string;
  /** device lock reason (e.g. "admin_lock"); picks the caption while locked */
  lockReason?: string | null;
  /** replaces the caption entirely (null hides it) */
  caption?: string | null;
  /** the value is the last known one (agent offline): dimmed, and the caption says so */
  stale?: boolean;
}

export function lockCaption(reason: string | null | undefined): string {
  if (reason === "admin_lock") return "Locked by your security admin — only an admin can unlock it.";
  if (reason === "voice_spoof") return "Locked: the voice check flagged a synthetic voice. Behavior alone never locks.";
  if (reason === "voice_impostor") return "Locked: the voice didn't match the owner. Behavior alone never locks.";
  if (reason === "lock") return "Locked: the one-time-code fallback failed. Behavior alone never locks.";
  return "Locked by a failed voice check — behavior alone never locks.";
}

/** Big live trust gauge: arc colored by level, display %, level label; LOCKED and learning states. */
export function TrustGauge({ trust, locked, learning, size = "md", className, lockReason, caption, stale = false }: TrustGaugeProps) {
  const isLocked = Boolean(locked || trust?.locked || trust?.level === "locked");
  const level: Level = isLocked ? "locked" : learning ? "learning" : (trust?.level ?? "learning");
  const conf = trust?.confidence ?? 0;
  // Locked: the whole ring turns violet (sticky state, not a confidence).
  const value = isLocked ? 1 : Math.max(0.005, Math.min(1, conf));
  const color = levelColor(level);
  const display = trust ? Math.min(99, trust.display) : null;
  const xl = size === "xl";
  // Below the arc (never inside it, where it would cross the 0 / 100 labels on a small gauge).
  const text =
    caption !== undefined
      ? caption
      : stale
        ? "Last known value — the agent is offline."
        : isLocked
          ? lockCaption(lockReason)
          : level === "learning"
            ? "No model yet — collecting a baseline."
            : xl
              ? "Confidence it's still the enrolled owner."
              : "Confidence that the enrolled owner is still at the keyboard.";

  return (
    <div className={cn("mx-auto w-full", xl ? "max-w-[420px]" : "max-w-[260px]", className)}>
    <div className={cn("relative aspect-square w-full transition-opacity", stale && "opacity-50")}>
      <svg viewBox="0 0 200 200" className="size-full overflow-visible" role="img" aria-label={`Trust ${display ?? "unknown"}%, ${levelLabel(level)}`}>
        <defs>
          <filter id="gauge-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
        </defs>
        {/* track */}
        <path d={FULL} fill="none" stroke="var(--muted)" strokeWidth={12} strokeLinecap="round" />
        {/* band hints on the inner ring */}
        <path d={arc(0, TRUST_CONFIG.levels.watch, R - 13)} fill="none" stroke="var(--trust-suspicious)" strokeOpacity={0.35} strokeWidth={2} />
        <path d={arc(TRUST_CONFIG.levels.watch, TRUST_CONFIG.levels.normal, R - 13)} fill="none" stroke="var(--trust-watch)" strokeOpacity={0.35} strokeWidth={2} />
        <path d={arc(TRUST_CONFIG.levels.normal, 1, R - 13)} fill="none" stroke="var(--trust-normal)" strokeOpacity={0.35} strokeWidth={2} />
        {/* threshold ticks */}
        {[TRUST_CONFIG.levels.watch, TRUST_CONFIG.levels.normal].map((t) => {
          const a = polar(START + SWEEP * t, R - 18);
          const b = polar(START + SWEEP * t, R + 9);
          return <line key={t} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--muted-foreground)" strokeOpacity={0.6} strokeWidth={1.2} />;
        })}
        {/* glow + value */}
        {(trust || isLocked) && (
          <motion.path
            d={FULL}
            fill="none"
            stroke={color}
            strokeWidth={12}
            strokeLinecap="round"
            filter="url(#gauge-glow)"
            opacity={0.35}
            initial={false}
            animate={{ pathLength: value }}
            transition={{ type: "spring", stiffness: 60, damping: 18 }}
          />
        )}
        {(trust || isLocked) && (
          <motion.path
            d={FULL}
            fill="none"
            stroke={color}
            strokeWidth={12}
            strokeLinecap="round"
            opacity={isLocked ? 0.55 : 1}
            initial={false}
            animate={{ pathLength: value }}
            transition={{ type: "spring", stiffness: 60, damping: 18 }}
          />
        )}
        {/* scale labels */}
        {[0, TRUST_CONFIG.levels.watch, TRUST_CONFIG.levels.normal, 1].map((t) => {
          const p = polar(START + SWEEP * t, R + 16);
          return (
            <text key={t} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle" fill="var(--muted-foreground)" fontSize={7.5} className="font-mono">
              {Math.round(t * 100)}
            </text>
          );
        })}
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center pt-2">
        {isLocked ? (
          <>
            <Lock className={cn("mb-1 text-trust-locked", size === "xl" ? "size-12" : "size-8")} />
            <div className={cn("font-semibold tracking-[0.2em] text-trust-locked", size === "xl" ? "text-4xl" : "text-2xl")}>LOCKED</div>
          </>
        ) : (
          <>
            <div className={cn("tnum flex items-start font-semibold tracking-tighter", size === "xl" ? "text-[7.5rem] leading-none" : "text-6xl leading-none")}>
              <motion.span key={level} initial={{ opacity: 0.6 }} animate={{ opacity: 1 }}>
                {display ?? "—"}
              </motion.span>
              {display !== null && <span className={cn("ml-0.5 font-medium text-muted-foreground", size === "xl" ? "mt-3 text-4xl" : "mt-1.5 text-2xl")}>%</span>}
            </div>
            <div
              className={cn("mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-medium", size === "xl" ? "text-lg" : "text-xs")}
              style={{ color, background: `color-mix(in oklch, ${color} 14%, transparent)` }}
            >
              {level === "learning" && <GraduationCap className="size-3.5" />}
              {levelLabel(level)}
            </div>
          </>
        )}
      </div>
    </div>
      {text !== null && (
        <p className={cn("text-center text-muted-foreground", xl ? "-mt-1 text-sm" : "-mt-3 text-[11px]", stale && "text-trust-watch")}>{text}</p>
      )}
    </div>
  );
}
