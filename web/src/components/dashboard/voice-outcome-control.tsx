"use client";

// Stub voice only (§8 C2 "Stub honesty"): the observer screen picks the outcome of this device's next voice check,
// so the Block beat stays demoable without pretending a live analysis happened. Every result it produces is flagged
// simulated and badged on every screen. Hidden unless the server reports VOICE_MODE=stub.
//
// The server holds a pick until it is cleared (and it applies to unlock checks too), but it can't be read back. So
// this control never claims a state it didn't set: it opens with nothing selected, a manual pick covers the NEXT
// voice check on the device only (cleared automatically once that result arrives), and Reset demo clears it.
import { FlaskConical, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "@/lib/api";
import type { MarkerPoint, VoiceDecision } from "@/lib/contracts";
import type { LiveVoiceResult } from "@/lib/live";
import { cn } from "@/lib/utils";

import { lastResetAt } from "./voice-format";

type Choice = VoiceDecision | "AUTO";

const CHOICES: { value: Choice; label: string; color: string; hint: string }[] = [
  { value: "AUTO", label: "Auto", color: "var(--brand)", hint: "label-aware default (the server decides from the ground-truth label)" },
  { value: "VERIFY", label: "VERIFY", color: "var(--trust-normal)", hint: "owner verified (next check only)" },
  { value: "BLOCK_SPOOF", label: "BLOCK_SPOOF", color: "var(--trust-suspicious)", hint: "synthetic (cloned) voice → lock (next check only)" },
  { value: "BLOCK_IMPOSTOR", label: "BLOCK_IMPOSTOR", color: "var(--trust-suspicious)", hint: "different speaker → lock (next check only)" },
  { value: "FALLBACK_MFA", label: "FALLBACK_MFA", color: "var(--trust-watch)", hint: "gray zone → authenticator code (next check only)" },
];

/** A manual pick waiting for the next voice result on the device. */
export interface PendingOutcome {
  decision: VoiceDecision;
  /** voice results already on screen when it was picked (the next one is any other) */
  seen: string[];
  /** the last Reset marker when it was picked (a newer Reset clears it) */
  resetAt: number;
}

export const resultKey = (r: Pick<LiveVoiceResult, "challenge_id" | "t">) => `${r.challenge_id}@${r.t}`;

/** Pure: has the pick been used (a new voice result arrived) or voided (a Reset since)? */
export function pendingSettled(p: PendingOutcome, results: Pick<LiveVoiceResult, "challenge_id" | "t">[], markers: MarkerPoint[]): "used" | "reset" | null {
  if (lastResetAt(markers) > p.resetAt) return "reset";
  const seen = new Set(p.seen);
  return results.some((r) => !seen.has(resultKey(r))) ? "used" : null;
}

const storeKey = (deviceId: string) => `2bme:stage:voice-outcome:${deviceId}`;

function readPending(deviceId: string | null): PendingOutcome | null {
  if (!deviceId) return null;
  try {
    const v: unknown = JSON.parse(window.sessionStorage.getItem(storeKey(deviceId)) ?? "null");
    const o = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
    if (!o || typeof o.decision !== "string" || !Array.isArray(o.seen)) return null;
    return { decision: o.decision as VoiceDecision, seen: o.seen.filter((x): x is string => typeof x === "string"), resetAt: typeof o.resetAt === "number" ? o.resetAt : -Infinity };
  } catch {
    return null;
  }
}

function writePending(deviceId: string | null, p: PendingOutcome | null) {
  if (!deviceId) return;
  try {
    if (p) window.sessionStorage.setItem(storeKey(deviceId), JSON.stringify(p));
    else window.sessionStorage.removeItem(storeKey(deviceId));
  } catch {
    /* per-tab convenience only */
  }
}

export function VoiceOutcomeControl({
  deviceId,
  mock,
  voiceResults,
  markers,
  bare = false,
  compact = false,
  className,
}: {
  deviceId: string | null;
  mock: boolean;
  /** this device's voice results (newest first) */
  voiceResults: LiveVoiceResult[];
  markers: MarkerPoint[];
  /** no panel chrome (inside the stage view's sticky control bar) */
  bare?: boolean;
  /** one row (inline next to the stage buttons at xl): the status line moves into the label's tooltip */
  compact?: boolean;
  className?: string;
}) {
  // null = nothing picked from this screen (the server may still hold an older pick; Auto clears it)
  const [choice, setChoice] = useState<Choice | null>(null);
  const [pending, setPending] = useState<PendingOutcome | null>(null);
  const [busy, setBusy] = useState<Choice | null>(null);
  const clearing = useRef(false);

  // a reload of the stage view keeps this tab's one-shot pick (it can't be read back from the server)
  useEffect(() => {
    const p = readPending(deviceId);
    setPending(p);
    setChoice(p ? p.decision : null);
  }, [deviceId]);

  const keep = (p: PendingOutcome | null) => {
    setPending(p);
    writePending(deviceId, p);
  };

  // one-shot: once the next voice result arrives (or the demo is reset), put the device back on Auto
  const settled = pending ? pendingSettled(pending, voiceResults, markers) : null;
  useEffect(() => {
    if (!pending || !settled || clearing.current) return;
    clearing.current = true;
    const run = mock || !deviceId ? Promise.resolve() : api.demoVoiceOutcome(deviceId, null).then(() => undefined);
    run
      .then(
        () => {
          setPending(null);
          writePending(deviceId, null);
          setChoice("AUTO");
          if (settled === "used") toast.message(`Simulated ${pending.decision} used for that voice check · back to Auto`);
        },
        (e: unknown) => toast.error(`Couldn't put the simulated voice outcome back to Auto: ${errorMessage(e)}`),
      )
      .finally(() => {
        clearing.current = false;
      });
  }, [settled, pending, deviceId, mock]);

  async function pick(c: Choice) {
    if (!mock && !deviceId) {
      toast.error("No device yet — start the agent first");
      return;
    }
    setBusy(c);
    try {
      if (!mock && deviceId) await api.demoVoiceOutcome(deviceId, c === "AUTO" ? null : c);
      setChoice(c);
      keep(c === "AUTO" ? null : { decision: c, seen: voiceResults.map(resultKey), resetAt: lastResetAt(markers) });
      toast.success(c === "AUTO" ? "Simulated voice outcome: Auto (label-aware)" : `Next voice check on this device → ${c} (simulated), then back to Auto`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const sub =
    choice === null
      ? "not set from this screen · Auto = label-aware default"
      : choice === "AUTO"
        ? "Auto · the server decides from the ground-truth label"
        : `${choice} for the next voice check only, then Auto`;

  return (
    <div className={cn("flex gap-2.5", compact ? "flex-wrap items-center" : "flex-col lg:flex-row lg:items-center", !bare && "panel px-4 py-3", className)}>
      <div className="flex shrink-0 items-center gap-2" title={compact ? sub : undefined}>
        <FlaskConical className="size-4 text-trust-watch" />
        <div className="leading-tight">
          <div className="text-sm font-medium">
            Voice outcome{!compact && " (simulated)"}
          </div>
          {compact && <div className="text-[11px] text-trust-watch">simulated · next check</div>}
          <div className={cn("text-[11px] text-muted-foreground", compact && "hidden")} data-testid="voice-outcome-sub">
            {sub}
          </div>
        </div>
      </div>
      <div role="radiogroup" aria-label="Simulated voice outcome" className={cn("flex flex-wrap gap-1.5", compact ? "ml-auto" : "lg:ml-auto")}>
        {CHOICES.map((c) => {
          const on = choice === c.value;
          return (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={on}
              title={c.hint}
              disabled={busy !== null}
              onClick={() => void pick(c.value)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 font-mono text-xs transition-colors disabled:opacity-60",
                on ? "font-semibold text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              style={on ? { borderColor: `color-mix(in oklch, ${c.color} 60%, transparent)`, background: `color-mix(in oklch, ${c.color} 16%, transparent)` } : undefined}
            >
              {busy === c.value ? <Loader2 className="size-3 animate-spin" /> : <span className="size-1.5 rounded-full" style={{ background: c.color }} />}
              {c.label}
              {on && c.value !== "AUTO" && <span className="font-sans text-[10px] font-normal text-muted-foreground">· next</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
