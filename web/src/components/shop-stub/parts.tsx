// STUB (A0) — owner: Codex 2
"use client";

import { AudioLines, Check, Laptop, Link2, X } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TRUST_CONFIG, type DecisionDetailOut, type DecisionOut, type Tier } from "@/lib/contracts";
import type { LiveState } from "@/lib/live";
import { fmtClock, fmtPct, levelColor, shortId } from "@/lib/ui";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Binding badge: device label · heartbeat age · live confidence
// ---------------------------------------------------------------------------

export function BindingBadge({ state, now }: { state: LiveState; now: number }) {
  const device = state.device;
  const hb = state.health?.heartbeat_age_s;
  const age = hb === null || hb === undefined ? null : hb + (state.healthAt ? Math.max(0, (now - state.healthAt) / 1000) : 0);
  const stale = age === null || age >= TRUST_CONFIG.binding.heartbeat_max_s;
  const bad = !device || stale;
  const remote = state.presence?.binding === "remote";
  const color = bad ? "var(--trust-suspicious)" : remote ? "var(--trust-watch)" : "var(--trust-normal)";
  const trust = state.trust;
  const locked = Boolean(device?.locked || trust?.locked);
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm"
      style={{ borderColor: `color-mix(in oklch, ${color} 45%, transparent)`, background: `color-mix(in oklch, ${color} 8%, transparent)` }}
    >
      <span className="inline-flex items-center gap-1.5 font-medium" style={{ color }}>
        <Link2 className="size-4" /> {bad ? "No binding" : remote ? "Remote session" : "Bound"}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Laptop className="size-3.5 text-muted-foreground" />
        {device?.label ?? "no device"}
      </span>
      <span className={cn("tnum font-mono text-xs", stale ? "text-trust-suspicious" : "text-muted-foreground")}>
        heartbeat {age === null ? "—" : `${age < 10 ? age.toFixed(1) : Math.round(age)}s`}
      </span>
      <span className="tnum font-mono text-xs" style={{ color: locked ? "var(--trust-locked)" : trust ? levelColor(trust.level) : undefined }}>
        {locked ? "locked" : trust ? `${Math.min(99, trust.display)}% confidence` : "confidence —"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tier × confidence matrix (TRUST_CONFIG.policy.tiers)
// ---------------------------------------------------------------------------

const R1_USD = TRUST_CONFIG.policy.tiers.R1.purchase_below_cents / 100;
const R2_USD = TRUST_CONFIG.policy.tiers.R2.purchase_below_cents / 100;
const TIER_WHAT: Record<Tier, string> = {
  R0: "view",
  R1: `purchase < $${R1_USD}`,
  R2: `purchase $${R1_USD}–$${R2_USD - 1} · export`,
  R3: `purchase ≥ $${R2_USD} · add payee · password change`,
};

export function TierMatrix({ confidence, activeTier, locked }: { confidence: number | null; activeTier: Tier; locked: boolean }) {
  const tiers = Object.entries(TRUST_CONFIG.policy.tiers) as [Tier, { min_conf: number }][];
  return (
    <div className="space-y-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tier</TableHead>
            <TableHead>Covers</TableHead>
            <TableHead className="text-right">Allow ≥</TableHead>
            <TableHead className="text-right">Now</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tiers.map(([t, cfg]) => {
            const pass = !locked && confidence !== null && confidence >= cfg.min_conf;
            const active = t === activeTier;
            return (
              <TableRow key={t} className={cn(active && "bg-muted/60")}>
                <TableCell className="font-mono text-xs font-semibold">
                  {t}
                  {active && <span className="ml-1.5 text-[10px] font-normal text-brand">this order</span>}
                </TableCell>
                <TableCell className="text-xs whitespace-normal text-muted-foreground">{TIER_WHAT[t]}</TableCell>
                <TableCell className="tnum text-right font-mono text-xs">{fmtPct(cfg.min_conf)}</TableCell>
                <TableCell className="text-right">
                  {confidence === null && !locked ? (
                    <span className="text-muted-foreground">—</span>
                  ) : pass ? (
                    <span className="inline-flex items-center gap-1 text-xs text-trust-normal">
                      <Check className="size-3.5" /> allow
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs text-trust-watch">
                      <X className="size-3.5" /> {locked ? "block" : "step-up"}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="text-[11px] text-muted-foreground">
        Evaluated after the tick that contains the click. Behavior alone never blocks: below the bar you get a step-up (C), and only a locked
        device returns N.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3-D Secure-style result card
// ---------------------------------------------------------------------------

const TS_STYLE = {
  Y: { color: "var(--trust-normal)", title: "Approved — frictionless" },
  C: { color: "var(--trust-watch)", title: "Step-up required" },
  N: { color: "var(--trust-suspicious)", title: "Declined" },
} as const;

export function ResultCard({ decision, detail, wasStepUp = false }: { decision: DecisionOut; detail: DecisionDetailOut | null; wasStepUp?: boolean }) {
  const ts = decision.trans_status;
  const st = TS_STYLE[ts];
  const title = wasStepUp && ts === "Y" ? "Approved after step-up" : wasStepUp && ts === "N" ? "Declined after step-up" : st.title;
  const final = detail?.final_trans_status ?? null;
  const verifyHref = decision.challenge_id
    ? `/verify?c=${encodeURIComponent(decision.challenge_id)}&d=${encodeURIComponent(decision.decision_id)}`
    : null;

  return (
    <div className="panel overflow-hidden">
      <div className="border-b px-5 py-2.5 text-xs text-muted-foreground">3-D Secure-style result: Y/C/N (simulated)</div>
      <div className="flex gap-5 p-5">
        <div
          className="grid size-16 shrink-0 place-items-center rounded-2xl font-mono text-4xl font-bold"
          style={{ color: st.color, background: `color-mix(in oklch, ${st.color} 15%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${st.color} 40%, transparent)` }}
        >
          {ts}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="text-lg font-semibold" style={{ color: st.color }}>
            {title}
          </div>
          <div className="tnum flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
            <span>confidence {fmtPct(decision.confidence)}</span>
            <span>binding {decision.binding}</span>
            <span>tier {decision.tier}</span>
            <span>order {shortId(decision.decision_id)}</span>
            <span>{decision.status}</span>
          </div>
          {decision.reasons.length > 0 && (
            <ul className="space-y-0.5 text-sm">
              {decision.reasons.map((r) => (
                <li key={r} className="flex gap-2">
                  <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground" />
                  {r.replaceAll("_", " ")}
                </li>
              ))}
            </ul>
          )}
          {ts === "C" && (
            <div className="pt-1">
              {final ? null : verifyHref ? (
                <Button asChild className="bg-trust-watch text-black hover:bg-trust-watch/85">
                  <Link href={verifyHref}>
                    <AudioLines /> Verify with voice
                  </Link>
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">No challenge was attached to this decision.</p>
              )}
            </div>
          )}
          {final && (
            <div
              className="inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-sm"
              style={{ color: TS_STYLE[final].color, borderColor: `color-mix(in oklch, ${TS_STYLE[final].color} 45%, transparent)` }}
            >
              Final: <b className="font-mono">{final}</b> {detail?.final_decision}
              {detail?.resolved_at ? <span className="text-xs text-muted-foreground">at {fmtClock(detail.resolved_at)}</span> : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
