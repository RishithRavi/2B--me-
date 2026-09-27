"use client";

import { useMemo } from "react";

import { liveFeatureValues } from "@/components/dashboard/identity-card";
import { isRetired } from "@/components/lab/metrics";
import { FEATURE_SPEC, type Modality } from "@/lib/contracts";
import type { LiveState } from "@/lib/live";
import { MODALITIES, featureLabel, modalityColor, modalityIcon } from "@/lib/ui";
import { cn } from "@/lib/utils";

const RECENT_MS = 90_000;
/** Features the agent never sends (derived by the model on the server). */
const MODEL_DERIVED = new Set(["wf.markov_ll"]);

type Signature = Record<Modality, Record<string, readonly string[]>>;
const SIGNATURE = FEATURE_SPEC.signature as unknown as Signature;

/**
 * Which goal.txt leaves are live right now: a leaf is lit when a recent block for its modality carried a
 * non-null value for one of the leaf's features (from the literal last tick / the live context / why-chips).
 */
export function leafActivity(state: LiveState): Record<Modality, Record<string, boolean>> {
  const values = liveFeatureValues(state.last_tick_json, state.context);
  const topSeen = new Set(state.blocks.flatMap((b) => b.top.map((d) => d.feature)));
  const latest = Math.max(0, ...state.blocks.map((b) => Date.parse(b.t_end)));
  const recent: Partial<Record<Modality, boolean>> = {};
  for (const m of MODALITIES) {
    const b = state.lastBlocks[m];
    recent[m] = Boolean(b && latest - Date.parse(b.t_end) <= RECENT_MS);
  }
  if (state.context?.psd) recent.temporal = true;

  const out = {} as Record<Modality, Record<string, boolean>>;
  for (const m of MODALITIES) {
    out[m] = {};
    const hasValuesForModality = Object.keys(values).some((k) => k.startsWith(`${FEATURE_SPEC.modalities[m].features[0].name.split(".")[0]}.`));
    for (const [leaf, feats] of Object.entries(SIGNATURE[m])) {
      if (!recent[m]) {
        out[m][leaf] = false;
      } else if (feats.every((f) => MODEL_DERIVED.has(f))) {
        out[m][leaf] = true; // computed server-side from category transitions
      } else if (hasValuesForModality) {
        out[m][leaf] = feats.some((f) => values[f] !== undefined) || feats.some((f) => topSeen.has(f));
      } else {
        out[m][leaf] = true;
      }
    }
  }
  return out;
}

const TITLES: Record<Modality, string> = {
  keyboard: "Keyboard",
  mouse: "Mouse / Trackpad",
  scroll: "Scrolling",
  workflow: "Workflow",
  temporal: "Temporal signature",
};

/** The newGoal BEHAVIORAL SIGNATURE, rendered from feature_spec.yaml (every leaf maps to real features). */
export function SignatureTree({ state, live }: { state: LiveState; live: boolean }) {
  const active = useMemo(() => leafActivity(state), [state]);
  const totalLeaves = MODALITIES.reduce((n, m) => n + Object.keys(SIGNATURE[m]).length, 0);
  const totalFeatures = MODALITIES.reduce((n, m) => n + FEATURE_SPEC.modalities[m].features.length, 0);
  const lit = live ? MODALITIES.reduce((n, m) => n + Object.values(active[m] ?? {}).filter(Boolean).length, 0) : 0;

  return (
    <div>
      {/* root node + connector bar (drawn only where the branches sit side by side) */}
      <div className="flex flex-col items-center">
        <div className="inline-flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-2xl border bg-card px-4 py-2 shadow-sm">
          <span className="font-mono text-xs font-semibold tracking-[0.14em] whitespace-nowrap uppercase">Behavioral signature</span>
          <span className="tnum font-mono text-[11px] whitespace-nowrap text-muted-foreground">
            {totalLeaves} leaves · {totalFeatures} features
          </span>
          {live && (
            <span className="tnum inline-flex items-center gap-1.5 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
              <span className="size-1.5 animate-pulse-dot rounded-full bg-brand" />
              {lit} live
            </span>
          )}
        </div>
        <div className="h-5 w-px bg-border" />
      </div>
      <div className="relative hidden lg:block">
        <div className="absolute top-0 right-[10%] left-[10%] h-px bg-border" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {MODALITIES.map((m) => {
          const Icon = modalityIcon(m);
          const leaves = Object.entries(SIGNATURE[m]);
          return (
            <div key={m} className="relative lg:pt-5">
              <span className="absolute top-0 left-1/2 hidden h-5 w-px bg-border lg:block" />
              <div className="panel h-full p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="grid size-7 place-items-center rounded-lg" style={{ background: `color-mix(in oklch, ${modalityColor(m)} 16%, transparent)` }}>
                    <Icon className="size-4" style={{ color: modalityColor(m) }} />
                  </span>
                  <span className="text-sm font-medium">{TITLES[m]}</span>
                  {isRetired(m) && (
                    <span
                      className="rounded-full border px-1.5 py-px font-mono text-[9px] tracking-wide whitespace-nowrap text-muted-foreground uppercase"
                      title="Captured by the agent, but retired from the identity model: not scored"
                    >
                      captured · not scored
                    </span>
                  )}
                </div>
                <ul className="relative space-y-2 border-l border-border pl-3.5">
                  {leaves.map(([leaf, feats]) => {
                    const on = live && active[m]?.[leaf];
                    return (
                      <li key={leaf} className="group relative">
                        <span className="absolute top-[0.55rem] -left-3.5 h-px w-2.5 bg-border" />
                        <div className="flex items-center gap-2 text-[13px]">
                          <span
                            className={cn("size-1.5 shrink-0 rounded-full transition-colors", on && "animate-pulse-dot")}
                            style={{ background: on ? modalityColor(m) : "var(--muted-foreground)", opacity: on ? 1 : 0.35 }}
                            title={on ? "seen in a recent block" : "no recent evidence"}
                          />
                          <span className={cn(on ? "text-foreground" : "text-muted-foreground")}>{leafLabel(leaf)}</span>
                          <span className="tnum ml-auto font-mono text-[10px] text-muted-foreground/70">{feats.length}</span>
                        </div>
                        <div className="mt-0.5 hidden pl-3.5 text-[11px] leading-snug text-muted-foreground group-hover:block">
                          {feats.map((f) => featureLabel(f)).join(" · ")}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-3 font-mono text-[10px] text-muted-foreground">
                  {FEATURE_SPEC.modalities[m].features.length} features · block = {FEATURE_SPEC.modalities[m].n_ref}{" "}
                  {FEATURE_SPEC.modalities[m].n_unit.replace("_", "-")}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** "keyboard-mouse transitions" → "Keyboard ↔ mouse transitions" (the newGoal wording). */
function leafLabel(leaf: string): string {
  const s = leaf.replace("keyboard-mouse", "keyboard ↔ mouse");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
