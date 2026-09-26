"use client";

// "My behavior" (newGoal: the overlay is behavioral data for the user). The pill expands into this compact panel,
// still floating over other apps: live trust + sparkline, what each modality contributed to the last update, why,
// the identity model, the literal last payload that left the laptop, and recent events.
import { ChevronDown, ChevronUp, ExternalLink, Fingerprint, ListTree, PackageOpen, ShieldCheck, Sparkles, X } from "lucide-react";
import { useMemo, useState } from "react";

import { EventFeed } from "@/components/dashboard/event-feed";
import { ModalityBars } from "@/components/dashboard/modality-bars";
import { highlightJson } from "@/components/dashboard/tick-drawer";
import { WhyChips } from "@/components/dashboard/why-chips";
import { LogoMark } from "@/components/site/logo";
import { Button } from "@/components/ui/button";
import type { Level, ModelInfo, TrustPoint } from "@/lib/contracts";
import type { LiveState } from "@/lib/live";
import { fmtAgo, fmtClock, levelColor, levelLabel, modelBackendLabel } from "@/lib/ui";
import { cn } from "@/lib/utils";

/** 10-minute trust area chart with the 80% / 40% bands (pure SVG: this panel floats over other apps). */
export function TrustSpark({ history, color, height = 64 }: { history: TrustPoint[]; color: string; height?: number }) {
  const W = 320;
  const H = height;
  const { line, area } = useMemo(() => {
    const pts = history.slice(-120);
    if (pts.length < 2) return { line: "", area: "" };
    const t0 = Date.parse(pts[0].t);
    const t1 = Date.parse(pts[pts.length - 1].t);
    const span = Math.max(1, t1 - t0);
    const xy = pts.map((p) => {
      const x = ((Date.parse(p.t) - t0) / span) * (W - 2) + 1;
      const y = H - 2 - p.confidence * (H - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return { line: xy.join(" "), area: `1,${H} ${xy.join(" ")} ${W - 1},${H}` };
  }, [history, H]);
  const band = (c: number) => H - 2 - c * (H - 4);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-16 w-full" style={{ height: H }} aria-hidden>
      <defs>
        <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1="0" x2={W} y1={band(0.8)} y2={band(0.8)} stroke="var(--trust-normal)" strokeOpacity="0.35" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
      <line x1="0" x2={W} y1={band(0.4)} y2={band(0.4)} stroke="var(--trust-suspicious)" strokeOpacity="0.35" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
      {area && <polygon points={area} fill="url(#spark-fill)" />}
      {line && <polyline points={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

function Section({ icon: Icon, title, hint, children }: { icon: typeof Fingerprint; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border-t border-border/70 px-4 py-3">
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 text-muted-foreground" />
        <h3 className="text-[12px] font-medium">{title}</h3>
        {hint && <span className="ml-auto truncate text-[10.5px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function ModelLine({ model }: { model: ModelInfo | null }) {
  if (!model || model.status !== "ready") {
    return (
      <p className="text-xs text-muted-foreground">
        {model?.status === "training" ? "Training your identity model…" : "No identity model yet: 2bME is still learning how you work."}
      </p>
    );
  }
  const backend = modelBackendLabel(model.backend);
  return (
    <div className="space-y-1 text-xs">
      <div className="tnum font-mono">
        <span className="font-semibold">v{model.version ?? "?"}</span>
        <span className="text-muted-foreground">
          {" "}
          · +{model.learned_since_enroll} blocks learned · updated {fmtClock(model.trained_at, false)}
        </span>
      </div>
      {backend && (
        <div className="text-muted-foreground">
          Scored by <span className="text-foreground">{backend}</span>, trained only on your own behavior.
        </div>
      )}
    </div>
  );
}

function LeftLaptop({ tick }: { tick: Record<string, unknown> | null }) {
  const [open, setOpen] = useState(false);
  const json = useMemo(() => (tick ? JSON.stringify(tick, null, 2) : ""), [tick]);
  const bytes = tick ? new TextEncoder().encode(JSON.stringify(tick)).length : 0;
  const sentAt = typeof tick?.t_end === "string" ? tick.t_end : null;
  const blocks = Array.isArray(tick?.blocks) ? (tick.blocks as unknown[]).length : 0;
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!tick}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg border border-border/80 bg-muted/35 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/60 disabled:opacity-60"
      >
        <ShieldCheck className="size-3.5 shrink-0 text-trust-normal" />
        <span className="min-w-0 flex-1 truncate">
          {tick ? (
            <>
              {blocks} evidence block{blocks === 1 ? "" : "s"} · <span className="tnum font-mono">{bytes.toLocaleString()} B</span>
              {sentAt ? ` · ${fmtAgo(sentAt)}` : ""}
            </>
          ) : (
            "Nothing sent yet"
          )}
        </span>
        {open ? <ChevronUp className="size-3.5 text-muted-foreground" /> : <ChevronDown className="size-3.5 text-muted-foreground" />}
      </button>
      {open && json && (
        <pre className="scrollbar-thin max-h-56 overflow-auto rounded-lg bg-surface p-2.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
          {highlightJson(json)}
        </pre>
      )}
      <p className="text-[10.5px] leading-snug text-muted-foreground">
        Timing aggregates only: no keys, typed content, window titles, app names or screen coordinates.
      </p>
    </div>
  );
}

export function BehaviorPanel({
  state,
  onClose,
  dashboardHref,
  fill = false,
}: {
  state: LiveState;
  onClose: () => void;
  dashboardHref: string;
  /** fill the Electron window (no dead transparent area under the panel) */
  fill?: boolean;
}) {
  const locked = !!(state.device?.locked || state.trust?.locked);
  const learning = !state.model || state.model.status !== "ready" || state.device?.mode === "enroll";
  const level: Level | null = locked ? "locked" : learning && state.trust ? "learning" : (state.trust?.level ?? null);
  const color = levelColor(level);
  const display = state.trust ? Math.min(99, state.trust.display) : null;

  return (
    <div
      role="dialog"
      aria-label="My behavior"
      className={cn(
        "absolute right-2 top-2 flex w-[384px] flex-col overflow-hidden rounded-2xl border border-border bg-background/95 shadow-2xl backdrop-blur-md",
        fill ? "h-[calc(100vh-16px)]" : "max-h-[calc(100vh-16px)]",
      )}
    >
      {/* header (drag handle in the Electron shell) */}
      <div className="overlay-drag flex items-center gap-2.5 px-4 pt-3 pb-2">
        <LogoMark className="size-5 shrink-0" />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-sm font-semibold">My behavior</div>
          <div className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
            <span className={cn("size-1.5 rounded-full", !state.connected && "animate-pulse")} style={{ background: state.connected ? "var(--trust-normal)" : "var(--muted-foreground)" }} />
            {state.device?.label ?? "This Mac"} · {state.connected ? "live" : "reconnecting"}
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" className="overlay-no-drag" aria-label="Collapse to the pill" onClick={onClose}>
          <X />
        </Button>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overlay-no-drag">
        {/* trust hero */}
        <div className="px-4 pb-3">
          <div className="flex items-end gap-3">
            <div className="tnum text-4xl leading-none font-semibold" style={{ color }}>
              {display === null ? "—" : `${display}%`}
            </div>
            <div className="pb-0.5 leading-tight">
              <div className="text-xs font-medium uppercase tracking-wider" style={{ color }}>
                {levelLabel(level)}
              </div>
              <div className="text-[11px] text-muted-foreground">confidence it&apos;s still you</div>
            </div>
          </div>
          <div className="mt-2 rounded-lg bg-muted/30 px-1 pt-1">
            <TrustSpark history={state.trust_history} color={color} />
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
            <span>10 min ago</span>
            <span>bands 80% · 40%</span>
            <span>now</span>
          </div>
        </div>

        <Section icon={Fingerprint} title="What counted" hint="last update, per modality (ΔL)">
          <ModalityBars trust={state.trust} lastBlocks={state.lastBlocks} />
        </Section>

        <Section icon={Sparkles} title="Why" hint="largest deviations from your profile">
          <WhyChips blocks={state.blocks} limit={4} />
        </Section>

        <Section icon={Fingerprint} title="Your identity model">
          <ModelLine model={state.model} />
        </Section>

        <Section icon={PackageOpen} title="What left this laptop" hint="the literal last payload">
          <LeftLaptop tick={state.last_tick_json} />
        </Section>

        <Section icon={ListTree} title="Recent events">
          <EventFeed items={state.recent.slice(0, 6)} className="max-h-44" />
        </Section>
      </div>

      <div className="flex items-center gap-2 border-t border-border/70 px-4 py-2.5">
        <span className="text-[10.5px] text-muted-foreground">Behavior alone never blocks.</span>
        <Button asChild size="sm" variant="outline" className="ml-auto h-7 text-xs">
          <a href={dashboardHref} target="_blank" rel="noreferrer">
            Full dashboard <ExternalLink className="size-3" />
          </a>
        </Button>
      </div>
    </div>
  );
}
