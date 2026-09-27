import { describe, expect, it } from "vitest";

import type { ChallengeLive } from "@/lib/contracts";

import { IDLE_INPUTS, challengeKey, fullScreen, lockAuthority, overlayMode, rememberedLockHolds, settleAfterPrompt, type OverlayInputs } from "./overlay-state";

const ch = (trigger: ChallengeLive["trigger"], id = "c1"): ChallengeLive => ({
  challenge_id: id,
  trigger,
  status: "issued",
  attempt: 1,
  expires_at: null,
  verify_url: null,
});

// signed in, live snapshot of the owner's device received, trusted
const base: OverlayInputs = { ...IDLE_INPUTS, meStatus: "ok", synced: true };

describe("overlayMode", () => {
  it("is a pill while trusted", () => {
    expect(overlayMode(base)).toBe("pill");
  });

  it("prompts on a proactive or step-up challenge, not on sandbox/redteam/unlock", () => {
    expect(overlayMode({ ...base, challenge: ch("proactive") })).toBe("prompt");
    expect(overlayMode({ ...base, challenge: ch("step_up") })).toBe("prompt");
    expect(overlayMode({ ...base, challenge: ch("sandbox") })).toBe("pill");
    expect(overlayMode({ ...base, challenge: ch("redteam") })).toBe("pill");
    expect(overlayMode({ ...base, challenge: ch("unlock") })).toBe("pill");
  });

  it("snoozing hides the prompt until the challenge is refreshed for a step-up", () => {
    const armed = ch("proactive");
    expect(overlayMode({ ...base, challenge: armed, snoozedKey: challengeKey(armed) })).toBe("pill");
    expect(overlayMode({ ...base, challenge: ch("step_up"), snoozedKey: challengeKey(armed) })).toBe("prompt");
  });

  it("locks when the device is locked, and stays locked after the session is revoked", () => {
    expect(overlayMode({ ...base, locked: true, challenge: ch("proactive") })).toBe("lock");
    expect(overlayMode({ ...base, meStatus: "anon", synced: false, lastKnownLocked: true })).toBe("lock");
    expect(overlayMode({ ...base, meStatus: "anon", synced: false, lastKnownLocked: false })).toBe("pill");
  });

  it("opens the sign-in panel only on request and only when signed out", () => {
    expect(overlayMode({ ...base, meStatus: "anon", synced: false, wantPanel: true })).toBe("panel");
    expect(overlayMode({ ...base, wantPanel: true })).toBe("pill");
  });

  it("clicking the pill opens My behavior; a challenge or a lock takes over from it", () => {
    expect(overlayMode({ ...base, wantDetails: true })).toBe("details");
    expect(overlayMode({ ...base, wantDetails: true, challenge: ch("proactive") })).toBe("prompt");
    expect(overlayMode({ ...base, wantDetails: true, locked: true })).toBe("lock");
    // never for a signed-out or offline overlay
    expect(overlayMode({ ...base, meStatus: "anon", synced: false, wantDetails: true })).toBe("pill");
    expect(overlayMode({ ...base, meStatus: "offline", synced: false, wantDetails: true })).toBe("pill");
  });
});

describe("the lock fails closed", () => {
  it("offline + a remembered lock → lock, never the '2bME offline' pill", () => {
    expect(overlayMode({ ...base, meStatus: "offline", synced: false, lastKnownLocked: true })).toBe("lock");
  });

  it("loading (restart, cookie check in flight) + a remembered lock → lock", () => {
    expect(overlayMode({ ...base, meStatus: "loading", synced: false, lastKnownLocked: true })).toBe("lock");
  });

  it("signed in but the snapshot hasn't arrived + a remembered lock → still lock", () => {
    expect(overlayMode({ ...base, synced: false, lastKnownLocked: true })).toBe("lock");
  });

  it("a remembered lock is released only by the owner's live snapshot saying unlocked", () => {
    expect(rememberedLockHolds({ meStatus: "ok", synced: true, lastKnownLocked: true })).toBe(false);
    expect(overlayMode({ ...base, lastKnownLocked: true, locked: false })).toBe("pill");
    expect(rememberedLockHolds({ meStatus: "offline", synced: true, lastKnownLocked: true })).toBe(true);
  });

  it("fresh profile (nothing remembered) + a server-reported lock → lock", () => {
    expect(overlayMode({ ...base, lastKnownLocked: false, locked: true })).toBe("lock");
    // even before a device snapshot arrives (the lock came on trust.locked)
    expect(overlayMode({ ...base, synced: false, lastKnownLocked: false, locked: true })).toBe("lock");
  });

  it("offline with nothing remembered is the offline pill (no lock to protect)", () => {
    expect(overlayMode({ ...base, meStatus: "offline", synced: false })).toBe("pill");
  });
});

describe("prompt → lock ordering (no transient pill)", () => {
  const armed = ch("proactive");

  it("a closed prompt with no outcome yet holds the full-screen prompt", () => {
    expect(settleAfterPrompt(armed, null)).toBe("prompt");
    expect(overlayMode({ ...base, challenge: null, settling: "prompt" })).toBe("prompt");
  });

  it("the terminal challenge event, then BLOCK_*: straight to lock before the lock event lands", () => {
    // 1. challenge open → prompt
    expect(overlayMode({ ...base, challenge: armed })).toBe("prompt");
    // 2. terminal challenge event (open_challenge cleared), no voice result yet → still full screen
    const s2 = settleAfterPrompt(armed, null);
    expect(fullScreen(overlayMode({ ...base, challenge: null, settling: s2 }))).toBe(true);
    // 3. voice_result BLOCK_SPOOF → lock (the device lock event may still be in flight)
    const s3 = settleAfterPrompt(armed, "BLOCK_SPOOF");
    expect(s3).toBe("lock");
    expect(overlayMode({ ...base, challenge: null, settling: s3 })).toBe("lock");
    // 4. lock event → lock (and the session revocation keeps it there)
    expect(overlayMode({ ...base, challenge: null, settling: s3, locked: true })).toBe("lock");
    expect(overlayMode({ ...base, meStatus: "anon", synced: false, lastKnownLocked: true })).toBe("lock");
  });

  it("BLOCK_IMPOSTOR on a step-up also locks; VERIFY and FALLBACK_MFA release to the pill", () => {
    expect(settleAfterPrompt(ch("step_up"), "BLOCK_IMPOSTOR")).toBe("lock");
    expect(settleAfterPrompt(armed, "VERIFY")).toBeNull();
    expect(settleAfterPrompt(armed, "FALLBACK_MFA")).toBeNull();
    expect(overlayMode({ ...base, challenge: null, settling: settleAfterPrompt(armed, "VERIFY") })).toBe("pill");
  });

  it("a BLOCK on a sandbox/redteam check never locks", () => {
    expect(settleAfterPrompt(ch("sandbox"), "BLOCK_SPOOF")).toBeNull();
  });

  it("a new challenge while settling shows its prompt", () => {
    expect(overlayMode({ ...base, challenge: ch("step_up", "c2"), settling: "prompt" })).toBe("prompt");
  });
});

describe("lockAuthority: only a fresh snapshot of the remembered device speaks for the lock", () => {
  const A = "dev-a";
  const B = "dev-b";
  const memoA = { device_id: A };
  const live = { signedIn: true, fresh: true };

  it("the owner's fresh snapshot of the locked device is authoritative", () => {
    expect(lockAuthority({ ...live, deviceId: A, memo: memoA })).toEqual({ synced: true, foreign: false });
    expect(lockAuthority({ ...live, deviceId: A, memo: null })).toEqual({ synced: true, foreign: false });
  });

  it("another account's device (b@ signs in on A's lock screen) never releases A's lock", () => {
    const a = lockAuthority({ ...live, deviceId: B, memo: memoA });
    expect(a).toEqual({ synced: false, foreign: true });
    // B's own device is unlocked, yet the overlay stays locked
    expect(overlayMode({ ...base, synced: a.synced, locked: false, lastKnownLocked: true })).toBe("lock");
  });

  it("an admin (observer) never speaks for the lock, even when their socket binds the locked device", () => {
    expect(lockAuthority({ ...live, deviceId: A, memo: memoA, observer: true })).toEqual({ synced: false, foreign: true });
  });

  it("an account without a device can't release a remembered lock", () => {
    expect(lockAuthority({ ...live, deviceId: null, memo: memoA })).toEqual({ synced: false, foreign: true });
    expect(lockAuthority({ ...live, deviceId: null, memo: null })).toEqual({ synced: false, foreign: false });
  });

  it("state left over from an earlier connection (reconnecting, re-sign-in) is not authoritative", () => {
    const stale = lockAuthority({ signedIn: true, fresh: false, deviceId: A, memo: memoA });
    expect(stale).toEqual({ synced: false, foreign: false });
    expect(overlayMode({ ...base, synced: stale.synced, locked: false, lastKnownLocked: true })).toBe("lock");
    expect(lockAuthority({ signedIn: false, fresh: true, deviceId: A, memo: memoA }).synced).toBe(false);
  });

  it("an old memory without a device id is released by the signed-in owner's fresh snapshot", () => {
    expect(lockAuthority({ ...live, deviceId: A, memo: { device_id: null } })).toEqual({ synced: true, foreign: false });
  });
});
