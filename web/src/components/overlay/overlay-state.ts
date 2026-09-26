// Pure overlay mode logic (unit-tested). Behavior alone never blocks: a suspected takeover opens a dismissible
// full-screen voice check ("prompt"); only a device lock (a failed voice check) is the non-dismissible "lock".
// The lock fails CLOSED: a remembered lock holds until a live snapshot for the signed-in owner says otherwise.
import type { ChallengeLive, VoiceDecision } from "@/lib/contracts";

import type { OverlayMode } from "./bridge";

export type MeStatus = "loading" | "ok" | "anon" | "offline";

/** What the overlay holds while a prompt it was showing closes and the outcome is not known yet. */
export type Settling = "lock" | "prompt" | null;

export interface OverlayInputs {
  meStatus: MeStatus;
  /** server-reported lock: device.locked (snapshot / lock events) or the sticky locked flag on trust */
  locked: boolean;
  /** remembered across a revoked session, a restart or an outage (localStorage) */
  lastKnownLocked: boolean;
  /** the live stream delivered this owner's device, so `locked` is authoritative */
  synced: boolean;
  challenge: ChallengeLive | null;
  snoozedKey: string | null;
  /** sign-in card requested (signed out) */
  wantPanel: boolean;
  /** "My behavior" panel requested (clicked the pill) */
  wantDetails: boolean;
  /** a prompt just closed without a known outcome (see settleAfterPrompt) */
  settling: Settling;
}

export const IDLE_INPUTS: OverlayInputs = {
  meStatus: "ok",
  locked: false,
  lastKnownLocked: false,
  synced: false,
  challenge: null,
  snoozedKey: null,
  wantPanel: false,
  wantDetails: false,
  settling: null,
};

/** Key a challenge by id + trigger: a step-up that consumes an armed proactive challenge refreshes the phrase. */
export function challengeKey(c: ChallengeLive | null): string | null {
  return c ? `${c.challenge_id}:${c.trigger}` : null;
}

export function promptable(c: ChallengeLive | null): c is ChallengeLive {
  return !!c && (c.trigger === "proactive" || c.trigger === "step_up");
}

/** A remembered lock is released only by a live snapshot of the signed-in owner's device that says "unlocked". */
export function rememberedLockHolds(i: Pick<OverlayInputs, "meStatus" | "lastKnownLocked" | "synced">): boolean {
  return i.lastKnownLocked && !(i.meStatus === "ok" && i.synced);
}

export function overlayMode(i: OverlayInputs): OverlayMode {
  // 1. fail closed: server lock, or a remembered lock we can't disprove (offline, loading, signed out, no snapshot)
  if (i.locked || rememberedLockHolds(i)) return "lock";
  // 2. a blocked voice check on a proactive/step-up challenge locks the device: go straight there (no pill flash)
  if (i.settling === "lock") return "lock";
  // 3. a different person may be at the keyboard → voice check (dismissible)
  if (i.meStatus === "ok" && promptable(i.challenge) && challengeKey(i.challenge) !== i.snoozedKey) return "prompt";
  // 4. the prompt just closed and the outcome hasn't arrived: hold the full-screen window instead of resizing twice
  if (i.settling === "prompt") return "prompt";
  if (i.wantPanel && i.meStatus !== "ok") return "panel";
  if (i.wantDetails && i.meStatus === "ok") return "details";
  return "pill";
}

const BLOCKS: ReadonlySet<VoiceDecision> = new Set<VoiceDecision>(["BLOCK_SPOOF", "BLOCK_IMPOSTOR"]);

/**
 * A promptable challenge the overlay was showing has closed. The server emits the terminal challenge status first
 * and the voice result + lock right after, so without a hold the shell would resize prompt → pill → lock.
 * - BLOCK_* on a proactive/step-up challenge → the server locks the device (§5.4): go straight to "lock".
 * - VERIFY (or any other known outcome) → release to the pill.
 * - outcome unknown yet → hold "prompt" (the caller releases the hold after a short timeout).
 */
export function settleAfterPrompt(closed: ChallengeLive, decision: VoiceDecision | null): Settling {
  if (decision === null) return "prompt";
  if (BLOCKS.has(decision) && promptable(closed)) return "lock";
  return null;
}

/** How long the overlay holds full screen waiting for the outcome of a prompt that just closed. */
export const SETTLE_MS = 4000;

/** Full-screen modes (the shell covers the display). */
export function fullScreen(mode: OverlayMode): boolean {
  return mode === "prompt" || mode === "lock";
}
