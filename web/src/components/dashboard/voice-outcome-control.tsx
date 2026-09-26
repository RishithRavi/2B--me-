"use client";

// Stub voice only (§8 C2 "Stub honesty"): the observer screen picks the outcome of this device's next voice checks,
// so the Block beat stays demoable without pretending a live analysis happened. Every result it produces is flagged
// simulated and badged on every screen. Hidden unless the server reports VOICE_MODE=stub.
import { FlaskConical, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "@/lib/api";
import type { VoiceDecision } from "@/lib/contracts";
import { cn } from "@/lib/utils";

type Choice = VoiceDecision | "AUTO";

const CHOICES: { value: Choice; label: string; color: string; hint: string }[] = [
  { value: "AUTO", label: "Auto", color: "var(--brand)", hint: "label-aware default (the server decides from the ground-truth label)" },
  { value: "VERIFY", label: "VERIFY", color: "var(--trust-normal)", hint: "owner verified" },
  { value: "BLOCK_SPOOF", label: "BLOCK_SPOOF", color: "var(--trust-suspicious)", hint: "synthetic (cloned) voice → lock" },
  { value: "BLOCK_IMPOSTOR", label: "BLOCK_IMPOSTOR", color: "var(--trust-suspicious)", hint: "different speaker → lock" },
  { value: "FALLBACK_MFA", label: "FALLBACK_MFA", color: "var(--trust-watch)", hint: "gray zone → authenticator code" },
];

export function VoiceOutcomeControl({ deviceId, mock, className }: { deviceId: string | null; mock: boolean; className?: string }) {
  const [choice, setChoice] = useState<Choice>("AUTO");
  const [busy, setBusy] = useState<Choice | null>(null);

  async function pick(c: Choice) {
    if (!mock && !deviceId) {
      toast.error("No device yet — start the agent first");
      return;
    }
    setBusy(c);
    try {
      if (!mock && deviceId) await api.demoVoiceOutcome(deviceId, c === "AUTO" ? null : c);
      setChoice(c);
      toast.success(c === "AUTO" ? "Simulated voice outcome: auto (label-aware)" : `Next voice checks on this device → ${c} (simulated)`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={cn("panel flex flex-col gap-2.5 px-4 py-3 lg:flex-row lg:items-center", className)}>
      <div className="flex shrink-0 items-center gap-2">
        <FlaskConical className="size-4 text-trust-watch" />
        <div className="leading-tight">
          <div className="text-sm font-medium">Voice outcome (simulated)</div>
          <div className="text-[11px] text-muted-foreground">stub voice · results badged “Simulated” everywhere</div>
        </div>
      </div>
      <div role="radiogroup" aria-label="Simulated voice outcome" className="flex flex-wrap gap-1.5 lg:ml-auto">
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
            </button>
          );
        })}
      </div>
    </div>
  );
}
