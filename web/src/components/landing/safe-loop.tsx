import { ArrowDown, ArrowDownRight, ArrowRight, ArrowUpRight, Ban, BellRing, BrainCircuit, CheckCircle2, Fingerprint, History, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type Tone = "neutral" | "ok" | "stop" | "alert";

const TONE: Record<Tone, string> = {
  neutral: "var(--muted-foreground)",
  ok: "var(--trust-normal)",
  stop: "var(--trust-suspicious)",
  alert: "var(--trust-watch)",
};

function Node({ icon: Icon, title, sub, tone = "neutral", className }: { icon: LucideIcon; title: string; sub?: string; tone?: Tone; className?: string }) {
  const c = TONE[tone];
  return (
    <div
      className={cn("rounded-xl border bg-card p-3.5", className)}
      style={tone === "neutral" ? undefined : { borderColor: `color-mix(in oklch, ${c} 45%, transparent)`, background: `color-mix(in oklch, ${c} 7%, var(--card))` }}
    >
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0" style={{ color: tone === "neutral" ? "var(--brand)" : c }} />
        <span className="text-sm font-semibold">{title}</span>
      </div>
      {sub && <p className="mt-1.5 text-xs leading-snug text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Decision({ className }: { className?: string }) {
  return (
    <div className={cn("relative grid place-items-center", className)}>
      <div className="grid aspect-square w-36 rotate-45 place-items-center rounded-2xl border-2 border-brand/60 bg-brand/8">
        <div className="-rotate-45 px-3 text-center text-sm leading-tight font-semibold">
          High-confidence
          <br />
          legitimate?
        </div>
      </div>
    </div>
  );
}

const EDGE_ICON = { right: ArrowRight, down: ArrowDown, "up-right": ArrowUpRight, "down-right": ArrowDownRight } as const;

function Edge({ dir, label, tone = "neutral" }: { dir: keyof typeof EDGE_ICON; label?: ReactNode; tone?: Tone }) {
  const Icon = EDGE_ICON[dir];
  return (
    <div className={cn("flex items-center justify-center gap-1 text-muted-foreground", dir === "down" ? "flex-col py-1" : "px-1")}>
      {label && (
        <span className="rounded-full px-1.5 font-mono text-[11px] font-semibold" style={{ color: TONE[tone] }}>
          {label}
        </span>
      )}
      <Icon className="size-4" />
    </div>
  );
}

const STEPS = {
  observe: { icon: Fingerprint, title: "New behavior", sub: "a fresh evidence block: timing aggregates only" },
  evaluate: { icon: BrainCircuit, title: "Current model evaluates it", sub: "how typical is this for you?" },
  update: { icon: CheckCircle2, title: "Can update baseline", sub: "an update candidate, held in a 10-minute quarantine", tone: "ok" as const },
  retrain: { icon: History, title: "Next retrain", sub: "a new, versioned model of you; older versions are kept" },
  skip: { icon: Ban, title: "Don't train on this data", sub: "so an attacker can't teach the model their habits", tone: "stop" as const },
  alert: { icon: BellRing, title: "Challenge / alert", sub: "voice or TOTP step-up; the admin sees it", tone: "alert" as const },
};

/** newGoal's safe loop for model tuning, drawn as a flow (horizontal on desktop, stacked on phones). */
export function SafeLoop() {
  return (
    <div className="panel p-5 sm:p-8">
      {/* desktop: a fork. YES runs up-right to the baseline, NO runs down-right to the challenge */}
      <div className="hidden items-center gap-x-1 gap-y-3 md:grid md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_auto_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
        <Node {...STEPS.observe} className="col-start-1 row-start-2" />
        <div className="col-start-2 row-start-2">
          <Edge dir="right" />
        </div>
        <Node {...STEPS.evaluate} className="col-start-3 row-start-2" />
        <div className="col-start-4 row-start-2">
          <Edge dir="right" />
        </div>
        <Decision className="col-start-5 row-span-3 row-start-1 px-6" />
        <div className="col-start-6 row-start-1 self-end pb-6">
          <Edge dir="up-right" label="YES" tone="ok" />
        </div>
        <Node {...STEPS.update} className="col-start-7 row-start-1" />
        <div className="col-start-8 row-start-1">
          <Edge dir="right" />
        </div>
        <Node {...STEPS.retrain} className="col-start-9 row-start-1" />
        <div className="col-start-6 row-start-3 self-start pt-6">
          <Edge dir="down-right" label="NO" tone="stop" />
        </div>
        <Node {...STEPS.skip} className="col-start-7 row-start-3" />
        <div className="col-start-8 row-start-3">
          <Edge dir="right" />
        </div>
        <Node {...STEPS.alert} className="col-start-9 row-start-3" />
      </div>

      {/* phone: one column, the two outcomes side by side */}
      <div className="flex flex-col items-stretch md:hidden">
        <Node {...STEPS.observe} />
        <Edge dir="down" />
        <Node {...STEPS.evaluate} />
        <Edge dir="down" />
        <Decision className="py-6" />
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col">
            <Edge dir="down" label="YES" tone="ok" />
            <Node {...STEPS.update} />
            <Edge dir="down" />
            <Node {...STEPS.retrain} />
          </div>
          <div className="flex flex-col">
            <Edge dir="down" label="NO" tone="stop" />
            <Node {...STEPS.skip} />
            <Edge dir="down" />
            <Node {...STEPS.alert} />
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-3 border-t pt-5 text-xs leading-relaxed text-muted-foreground sm:grid-cols-3">
        <p>
          <b className="text-foreground">&ldquo;High-confidence&rdquo; is strict.</b> A block becomes an update candidate only with trust at 95% or more
          over the previous minute, strong evidence of its own, and no open or failed challenge, or right after a voice check verified you.
        </p>
        <p>
          <b className="text-foreground">Marked takeovers stay out.</b> Blocks marked as someone else, and anything from a locked or challenged device,
          never become update candidates. A password alone never makes behavior trusted.
        </p>
        <p>
          <b className="text-foreground">In this demo,</b> retraining is operator-triggered (&ldquo;Retrain now&rdquo;) and every model is versioned.
          Candidates from the 2 minutes before any alert are dropped, and retraining is guarded and versioned. Still to come: an automatic schedule.
        </p>
      </div>
    </div>
  );
}
