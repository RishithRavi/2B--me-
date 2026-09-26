"use client";

import { AudioLines, BrainCircuit, Loader2, RefreshCcw, RotateCcw, Target, UserRoundX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Label as TrustLabel, LiveDevice, ModelInfo } from "@/lib/contracts";
import { cn } from "@/lib/utils";

import type { DashboardActions } from "./use-actions";

function Spin({ on, children }: { on: boolean; children: React.ReactNode }) {
  return on ? <Loader2 className="animate-spin" /> : <>{children}</>;
}

/**
 * Operator controls: enroll/monitor, Train / Retrain now, "Impostor at keyboard (B)", Reset demo, Re-arm (31%),
 * and Unlock with voice while locked.
 */
export function Controls({
  device,
  model,
  label,
  actions,
  isAdmin,
  className,
}: {
  device: LiveDevice | null;
  model: ModelInfo | null;
  label: TrustLabel;
  actions: DashboardActions;
  isAdmin: boolean;
  className?: string;
}) {
  const { busy } = actions;
  const mode = device?.mode ?? "monitor";
  const hasModel = model?.status === "ready";
  const impostor = label === "impostor";

  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-3", className)}>
      {/* Enroll / monitor */}
      <label className="flex items-center gap-2 text-sm">
        <span className={cn(mode === "enroll" ? "text-foreground" : "text-muted-foreground")}>Enroll</span>
        <Switch
          checked={mode === "monitor"}
          onCheckedChange={(v) => void actions.setMode(v ? "monitor" : "enroll")}
          disabled={busy === "mode"}
          aria-label="Monitor mode"
        />
        <span className={cn(mode === "monitor" ? "text-foreground" : "text-muted-foreground")}>Monitor</span>
      </label>

      {hasModel ? (
        <Button variant="outline" size="sm" onClick={() => void actions.retrain()} disabled={busy === "retrain"}>
          <Spin on={busy === "retrain"}>
            <RefreshCcw />
          </Spin>
          Retrain now
        </Button>
      ) : (
        <Button size="sm" onClick={() => void actions.train()} disabled={busy === "train" || model?.status === "training"}>
          <Spin on={busy === "train" || model?.status === "training"}>
            <BrainCircuit />
          </Spin>
          Train
        </Button>
      )}

      <Separator orientation="vertical" className="hidden h-6 sm:block" />

      {/* Ground-truth label + marker */}
      <Tooltip>
        <TooltipTrigger asChild>
          <label
            className={cn(
              "flex items-center gap-2 rounded-lg border px-2.5 py-1 text-sm transition-colors",
              impostor ? "border-trust-suspicious/50 bg-trust-suspicious/10" : "border-border",
            )}
          >
            <UserRoundX className={cn("size-4", impostor ? "text-trust-suspicious" : "text-muted-foreground")} />
            Impostor at keyboard (B)
            <Switch checked={impostor} onCheckedChange={(v) => void actions.setTakeover(v)} disabled={busy === "takeover"} aria-label="Impostor at keyboard" />
          </label>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          Sets the ground-truth label and a takeover marker for the TTD stopwatch and eval. Markers never reach the scorer.
        </TooltipContent>
      </Tooltip>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {device?.locked && (
          <Button size="sm" onClick={() => void actions.unlockWithVoice()} disabled={busy === "unlock"} className="bg-trust-locked text-white hover:bg-trust-locked/85">
            <Spin on={busy === "unlock"}>
              <AudioLines />
            </Spin>
            Unlock with voice
          </Button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" onClick={() => void actions.rearm()} disabled={busy === "rearm" || !isAdmin}>
              <Spin on={busy === "rearm"}>
                <Target />
              </Spin>
              Re-arm (31%)
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">Operator beat: set trust to 31% for a repeatable attack demo. Admin only.</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" onClick={() => void actions.reset()} disabled={busy === "reset" || !isAdmin}>
              <Spin on={busy === "reset"}>
                <RotateCcw />
              </Spin>
              Reset demo
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            Cancels challenges, clears the lock, opens a new session at 97% (an operator action, not an authentication). Admin only.
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
