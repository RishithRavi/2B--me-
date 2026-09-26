"use client";

import { motion } from "framer-motion";
import { ArrowRight, Building2, Laptop, MonitorPlay, PlayCircle } from "lucide-react";
import Link from "next/link";

import { Dot } from "@/components/site/empty-state";
import { Button } from "@/components/ui/button";
import { useMounted, useNow } from "@/lib/hooks";
import type { LiveState } from "@/lib/live";
import { feedTone, fmtClock, levelColor, levelLabel, toneColor } from "@/lib/ui";

import { TrustSparkline } from "./trust-sparkline";

export function Hero({ state, simulated }: { state: LiveState; simulated: boolean }) {
  const now = useNow(1000);
  const mounted = useMounted();
  const trust = state.trust;
  const locked = Boolean(trust?.locked || state.device?.locked);
  const level = locked ? "locked" : (trust?.level ?? "learning");
  const color = levelColor(level);
  const latest = state.recent[0] ?? null;

  return (
    <section className="relative overflow-hidden border-b">
      <div className="bg-console-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black_10%,transparent_65%)]" />
      <div className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[60rem] -translate-x-1/2 rounded-full bg-brand/10 blur-3xl" />
      <div className="relative mx-auto grid max-w-6xl gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:py-24">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} className="space-y-7">
          <p className="eyebrow">Continuous behavioral authentication</p>
          <h1 className="text-4xl leading-[1.08] font-semibold tracking-tight text-balance sm:text-5xl">
            Login proves who you <em className="text-muted-foreground">were</em>.
            <br />
            <span className="text-brand-gradient">2bME</span> keeps checking who you <em className="text-brand">are</em>.
          </h1>
          <p className="max-w-xl text-lg text-pretty text-muted-foreground">
            2bME learns how one person types, points, scrolls and switches apps, from timing alone and never content. It keeps a live trust score for
            whoever is at the keyboard. When the rhythm stops matching, it asks for an independent check, a spoken phrase or a one-time code, instead of
            trusting the login.
          </p>

          <div className="flex flex-wrap gap-2 text-sm">
            <span className="inline-flex items-center gap-2 rounded-full border bg-card/60 px-3 py-1 text-muted-foreground">
              <Laptop className="size-3.5 text-brand" /> For individuals: guards your own Mac
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border bg-card/60 px-3 py-1 text-muted-foreground">
              <Building2 className="size-3.5 text-brand-2" /> For small companies: an org console for security teams
            </span>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg" className="h-10 px-4">
                <Link href="/dashboard?stage=1">
                  <MonitorPlay /> Watch the live dashboard <ArrowRight />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="h-10 px-4">
                <Link href="/admin?mock=1">
                  <Building2 /> Open the org console demo
                </Link>
              </Button>
            </div>
            <Link
              href="/dashboard?stage=1&mock=1"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
            >
              <PlayCircle className="size-4" /> No account? Watch a simulated takeover
            </Link>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="panel relative overflow-hidden p-5 shadow-2xl shadow-black/30"
        >
          <div className="flex items-center justify-between">
            <span className="eyebrow">{simulated ? "Simulated stream" : (state.device?.label ?? "Live")}</span>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Dot color={simulated ? "var(--trust-watch)" : state.connected ? "var(--trust-normal)" : "var(--muted-foreground)"} pulse={state.connected} />
              {simulated ? "demo data, not a real person" : state.connected ? "live" : "connecting…"}
            </span>
          </div>
          <div className="mt-4 flex items-end gap-4">
            <div className="tnum text-7xl leading-none font-semibold tracking-tighter" style={{ color: trust ? undefined : "var(--muted-foreground)" }}>
              {locked ? "—" : trust ? Math.min(99, trust.display) : "—"}
              <span className="text-3xl text-muted-foreground">%</span>
            </div>
            <div className="pb-1.5">
              <div
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-medium"
                style={{ color, background: `color-mix(in oklch, ${color} 14%, transparent)` }}
              >
                <span className="size-1.5 rounded-full" style={{ background: color }} />
                {levelLabel(level)}
              </div>
            </div>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">confidence that the enrolled owner is still at the keyboard</p>
          <div className="mt-5 h-32">{mounted && <TrustSparkline history={state.trust_history} now={now} height={128} />}</div>
          <div className="mt-2 flex justify-between font-mono text-[10px] text-muted-foreground">
            <span>−5 min</span>
            <span>bands at 80% and 40%</span>
            <span>now</span>
          </div>
          <div className="mt-4 flex min-h-9 items-center gap-2.5 rounded-lg bg-muted/50 px-3 py-2 text-xs">
            {latest ? (
              <>
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: toneColor(feedTone(latest.severity)) }} />
                <span className="tnum shrink-0 font-mono text-muted-foreground">{fmtClock(latest.t)}</span>
                <span className="truncate">{latest.text}</span>
              </>
            ) : (
              <span className="text-muted-foreground">Waiting for the first evidence block…</span>
            )}
          </div>
        </motion.div>
      </div>
    </section>
  );
}
