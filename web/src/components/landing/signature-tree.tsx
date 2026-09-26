"use client";

import { useMemo } from "react";

import { liveFeatureValues } from "@/components/dashboard/identity-card";
import { FEATURE_SPEC, type Modality } from "@/lib/contracts";
import type { LiveState } from "@/lib/live";
import { MODALITIES, featureLabel, modalityColor, modalityIcon, modalityLabel } from "@/lib/ui";
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

/** The goal.txt BEHAVIORAL SIGNATURE, rendered from feature_spec.yaml (every leaf maps to real features). */
export function SignatureTree({ state, live }: { state: LiveState; live: boolean }) {
  const active = useMemo(() => leafActivity(state), [state]);

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      {MODALITIES.map((m) => {
        const Icon = modalityIcon(m);
        const leaves = Object.entries(SIGNATURE[m]);
        return (
          <div key={m} className="panel p-4">
            <div className="mb-3 flex items-center gap-2">
              <span className="grid size-7 place-items-center rounded-lg" style={{ background: `color-mix(in oklch, ${modalityColor(m)} 16%, transparent)` }}>
                <Icon className="size-4" style={{ color: modalityColor(m) }} />
              </span>
              <span className="text-sm font-medium">{TITLES[m]}</span>
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
                        style={{ background: on ? modalityColor(m) : "var(--muted)" }}
                        title={on ? "seen in a recent block" : "no recent evidence"}
                      />
                      <span className={cn(on ? "text-foreground" : "text-muted-foreground")}>{leaf.charAt(0).toUpperCase() + leaf.slice(1)}</span>
                    </div>
                    <div className="mt-0.5 hidden pl-3.5 text-[11px] leading-snug text-muted-foreground group-hover:block">
                      {feats.map((f) => featureLabel(f)).join(" · ")}
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="mt-3 font-mono text-[10px] text-muted-foreground">
              {FEATURE_SPEC.modalities[m].features.length} features · {modalityLabel(m, true).toLowerCase()} block = {FEATURE_SPEC.modalities[m].n_ref}{" "}
              {FEATURE_SPEC.modalities[m].n_unit.replace("_", "-")}
            </div>
          </div>
        );
      })}
    </div>
  );
}
