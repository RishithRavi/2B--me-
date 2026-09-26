"use client";

// Small building blocks shared by the admin/org panel: sparkline, flag chips, avatar, synthetic tag, kind chips.
import {
  ArrowDownUp,
  AudioLines,
  BrainCircuit,
  FlaskConical,
  Globe,
  Lock,
  ScrollText,
  ShieldAlert,
  ShoppingCart,
  Siren,
  TrendingDown,
  UserCog,
  UserX,
  type LucideIcon,
} from "lucide-react";
import { useId } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AuditKind, Level, RosterRow } from "@/lib/contracts";
import { TRUST_CONFIG } from "@/lib/contracts";
import { SPARK_MAX, auditKindLabel, flagLabel, type OrgFlag } from "@/lib/org-live";
import { levelColor, levelLabel } from "@/lib/ui";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Sparkline (last ≤ 60 ticks, newest at the right edge)
// ---------------------------------------------------------------------------

export function OrgSpark({
  values,
  level,
  className,
  height = 28,
  thresholds = true,
  dim = false,
}: {
  values: readonly number[];
  level: Level;
  className?: string;
  height?: number;
  thresholds?: boolean;
  dim?: boolean;
}) {
  const uid = useId().replace(/:/g, "");
  const W = 240;
  const H = height;
  const pad = 3;
  const color = levelColor(level);
  const step = W / (SPARK_MAX - 1);
  const x0 = W - (values.length - 1) * step;
  const y = (c: number) => pad + (1 - Math.max(0, Math.min(1, c))) * (H - 2 * pad);
  const pts = values.map((c, i) => [x0 + i * step, y(c)] as const);
  const d = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const area = pts.length > 1 ? `${d} L${W},${H} L${pts[0][0].toFixed(1)},${H} Z` : "";
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cn("block w-full overflow-visible", dim && "opacity-45", className)} style={{ height: H }} aria-hidden>
      <defs>
        <linearGradient id={`osf-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {thresholds &&
        [TRUST_CONFIG.levels.normal, TRUST_CONFIG.levels.watch].map((t) => (
          <line key={t} x1={0} x2={W} y1={y(t)} y2={y(t)} stroke="var(--muted-foreground)" strokeOpacity={0.22} strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
        ))}
      {pts.length < 2 ? (
        <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--muted-foreground)" strokeOpacity={0.3} strokeDasharray="1 5" vectorEffect="non-scaling-stroke" />
      ) : (
        <>
          <path d={area} fill={`url(#osf-${uid})`} />
          <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </>
      )}
      {last && pts.length > 1 && <circle cx={last[0]} cy={last[1]} r={2.25} fill={color} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const FLAG_META: Record<OrgFlag, { icon: LucideIcon; color: string; hint: string }> = {
  takeover_suspected: {
    icon: UserX,
    color: "var(--trust-suspicious)",
    hint: "Behavior changed abruptly, like a change of hands. A voice check decides; behavior alone never blocks.",
  },
  insider_drift: {
    icon: TrendingDown,
    color: "var(--trust-watch)",
    hint: "Slow, sustained drift from the employee's own baseline: the insider-threat pattern. Review, don't block.",
  },
  remote_session: {
    icon: Globe,
    color: "var(--brand-2)",
    hint: "A browser session for this employee is not co-present with the device, so web actions use the 30% prior.",
  },
  admin_locked: { icon: Lock, color: "var(--trust-locked)", hint: "An admin locked this device. Only an admin can clear it." },
  challenge_open: { icon: AudioLines, color: "var(--trust-watch)", hint: "A voice/MFA step-up is waiting for this employee." },
};

export function FlagChip({ flag, compact = false }: { flag: string; compact?: boolean }) {
  const meta = FLAG_META[flag as OrgFlag] ?? { icon: ShieldAlert, color: "var(--muted-foreground)", hint: flagLabel(flag) };
  const Icon = meta.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium whitespace-nowrap",
            compact && "px-1",
          )}
          style={{
            color: meta.color,
            background: `color-mix(in oklch, ${meta.color} 13%, transparent)`,
            boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${meta.color} 28%, transparent)`,
          }}
        >
          <Icon className="size-3" />
          {!compact && flagLabel(flag)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{meta.hint}</TooltipContent>
    </Tooltip>
  );
}

export function FlagChips({ flags, className, empty = true }: { flags: readonly string[]; className?: string; empty?: boolean }) {
  if (!flags.length) return empty ? <span className={cn("hidden text-xs text-muted-foreground/70 lg:inline", className)}>clear</span> : null;
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {flags.map((f) => (
        <FlagChip key={f} flag={f} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Identity bits
// ---------------------------------------------------------------------------

/** "Employee 07" → "07"; anything else → first two letters. */
export function handleShort(handle: string): string {
  const m = handle.match(/(\d+)\s*$/);
  if (m) return m[1].padStart(2, "0");
  return handle.slice(0, 2).toUpperCase();
}

export function EmployeeAvatar({ row, size = "md" }: { row: Pick<RosterRow, "handle" | "level" | "online" | "synthetic">; size?: "sm" | "md" | "lg" }) {
  const color = levelColor(row.level);
  const hot = row.level === "suspicious" || row.level === "locked";
  return (
    <span
      className={cn(
        "relative grid shrink-0 place-items-center rounded-full font-mono font-semibold tnum",
        size === "sm" && "size-7 text-[11px]",
        size === "md" && "size-9 text-xs",
        size === "lg" && "size-12 text-base",
        !row.online && "opacity-50",
      )}
      style={{
        color,
        background: `color-mix(in oklch, ${color} 14%, var(--card))`,
        boxShadow: `inset 0 0 0 1.5px color-mix(in oklch, ${color} 55%, transparent)`,
      }}
    >
      {hot && <span className="absolute -inset-0.5 animate-pulse rounded-full" style={{ boxShadow: `0 0 10px 1px color-mix(in oklch, ${color} 60%, transparent)` }} />}
      {row.synthetic ? handleShort(row.handle) : "A"}
    </span>
  );
}

/** compact: icon only below `sm` (roster rows on phones); the page banner carries the full label there. */
export function SyntheticTag({ synthetic, compact = false, className }: { synthetic: boolean; compact?: boolean; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex h-4 shrink-0 items-center gap-0.5 rounded px-1 font-mono text-[9.5px] font-medium tracking-wider uppercase",
            synthetic ? "bg-trust-watch/12 text-trust-watch" : "bg-brand/14 text-brand",
            className,
          )}
        >
          {synthetic ? <FlaskConical className="size-2.5" /> : null}
          <span className={cn(synthetic && compact && "hidden sm:inline")}>{synthetic ? "synthetic" : "real device"}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        {synthetic ? "Synthetic, anonymized demo employee. Not a real person or device." : "A real enrolled device streaming live behavioral trust."}
      </TooltipContent>
    </Tooltip>
  );
}

/** Big "97%" + level, or LOCKED / Learning. */
export function TrustFigure({ row, size = "md" }: { row: RosterRow; size?: "sm" | "md" }) {
  const color = levelColor(row.level);
  if (row.locked) {
    return (
      <div className="flex items-center gap-1.5" style={{ color }}>
        <Lock className={size === "md" ? "size-4" : "size-3.5"} />
        <span className={cn("font-semibold tracking-[0.12em]", size === "md" ? "text-sm" : "text-xs")}>LOCKED</span>
      </div>
    );
  }
  if (row.level === "learning") {
    return (
      <div className="flex flex-col leading-tight">
        <span className={cn("font-medium", size === "md" ? "text-sm" : "text-xs")} style={{ color }}>
          Learning
        </span>
        <span className="text-[11px] text-muted-foreground">enrolling baseline</span>
      </div>
    );
  }
  return (
    <div className="flex items-baseline gap-2">
      <span className={cn("tnum font-semibold tracking-tight", size === "md" ? "text-[1.6rem] leading-none" : "text-xl leading-none")} style={{ color }}>
        {row.display ?? "—"}
        <span className="ml-px text-[0.55em] font-medium text-muted-foreground">%</span>
      </span>
      <span className="text-[10.5px] font-medium tracking-wider uppercase" style={{ color }}>
        {levelLabel(row.level)}
      </span>
    </div>
  );
}

export function lockReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case "admin_lock":
      return "Admin lock";
    case "blocked_spoof":
      return "Synthetic voice blocked (BLOCK_SPOOF)";
    case "blocked_impostor":
      return "Different speaker (BLOCK_IMPOSTOR)";
    case null:
    case undefined:
      return "Locked";
    default:
      return reason.replace(/_/g, " ");
  }
}

// ---------------------------------------------------------------------------
// Audit kinds and severity
// ---------------------------------------------------------------------------

export const KIND_META: Record<AuditKind, { icon: LucideIcon; color: string }> = {
  alert: { icon: Siren, color: "var(--trust-suspicious)" },
  trust_change: { icon: ArrowDownUp, color: "var(--trust-learning)" },
  challenge: { icon: AudioLines, color: "var(--trust-watch)" },
  decision: { icon: ShoppingCart, color: "var(--brand)" },
  lock: { icon: Lock, color: "var(--trust-locked)" },
  admin_action: { icon: UserCog, color: "var(--brand-2)" },
  marker: { icon: ScrollText, color: "var(--muted-foreground)" },
  model: { icon: BrainCircuit, color: "var(--trust-normal)" },
};

export function KindChip({ kind, className }: { kind: AuditKind; className?: string }) {
  const meta = KIND_META[kind] ?? KIND_META.marker;
  const Icon = meta.icon;
  return (
    <span
      className={cn("inline-flex h-5 w-fit items-center gap-1 rounded-md px-1.5 text-[11px] font-medium whitespace-nowrap", className)}
      style={{ color: meta.color, background: `color-mix(in oklch, ${meta.color} 12%, transparent)` }}
    >
      <Icon className="size-3" />
      {auditKindLabel(kind)}
    </span>
  );
}

export function severityColor(sev: number): string {
  if (sev >= 5) return "var(--trust-locked)";
  if (sev >= 3) return "var(--trust-suspicious)";
  if (sev === 2) return "var(--trust-watch)";
  if (sev === 1) return "var(--trust-learning)";
  return "var(--muted-foreground)";
}

const SEV_LABEL = ["info", "notice", "warn", "alert", "high", "critical"];

export function SeverityMeter({ severity }: { severity: number }) {
  const color = severityColor(severity);
  return (
    <span className="inline-flex items-center gap-1.5" title={`severity ${severity} · ${SEV_LABEL[severity] ?? ""}`}>
      <span className="flex items-end gap-[2px]" aria-hidden>
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className="w-[3px] rounded-[1px]"
            style={{ height: 4 + i * 2, background: i <= severity ? color : "color-mix(in oklch, var(--muted-foreground) 22%, transparent)" }}
          />
        ))}
      </span>
      <span className="font-mono text-[10px] text-muted-foreground uppercase">{SEV_LABEL[severity] ?? severity}</span>
    </span>
  );
}
