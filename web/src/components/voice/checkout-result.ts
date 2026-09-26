import type { DecisionOut, VoiceOutcome } from "@/lib/contracts";

export function resolveCheckout(current: DecisionOut | null, outcome: VoiceOutcome): DecisionOut | null {
  if (!current || current.status === "final") return current;
  const resolved = outcome.resolved_decisions?.find((d) => d.decision_id === current.decision_id);
  if (!resolved) return current;
  return { ...current, status: "final", decision: resolved.decision, trans_status: resolved.trans_status };
}
