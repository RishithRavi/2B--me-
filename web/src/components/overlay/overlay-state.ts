// Pure overlay mode logic (unit-tested). Behavior alone never blocks: a suspected takeover opens a dismissible
// full-screen voice check ("prompt"); only a device lock (a failed voice check) is the non-dismissible "lock".
import type { ChallengeLive } from "@/lib/contracts";

import type { OverlayMode } from "./bridge";

export interface OverlayInputs {
  meStatus: "loading" | "ok" | "anon" | "offline";
  /** device.locked from the live snapshot / lock events */
  locked: boolean;
  /** remembered across a revoked session (the failed voice check signs the owner out) */
  lastKnownLocked: boolean;
  challenge: ChallengeLive | null;
  snoozedKey: string | null;
  wantPanel: boolean;
}

/** Key a challenge by id + trigger: a step-up that consumes an armed proactive challenge refreshes the phrase. */
export function challengeKey(c: ChallengeLive | null): string | null {
  return c ? `${c.challenge_id}:${c.trigger}` : null;
}

export function promptable(c: ChallengeLive | null): c is ChallengeLive {
  return !!c && (c.trigger === "proactive" || c.trigger === "step_up");
}

export function overlayMode(i: OverlayInputs): OverlayMode {
  if (i.locked || (i.meStatus === "anon" && i.lastKnownLocked)) return "lock";
  if (i.meStatus === "ok" && promptable(i.challenge) && challengeKey(i.challenge) !== i.snoozedKey) return "prompt";
  if (i.wantPanel && i.meStatus !== "ok") return "panel";
  return "pill";
}
