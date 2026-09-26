import { describe, expect, it } from "vitest";

import type { ChallengeLive } from "@/lib/contracts";

import { challengeKey, overlayMode, type OverlayInputs } from "./overlay-state";

const ch = (trigger: ChallengeLive["trigger"], id = "c1"): ChallengeLive => ({
  challenge_id: id,
  trigger,
  status: "issued",
  attempt: 1,
  expires_at: null,
  verify_url: null,
});

const base: OverlayInputs = { meStatus: "ok", locked: false, lastKnownLocked: false, challenge: null, snoozedKey: null, wantPanel: false };

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
    expect(overlayMode({ ...base, meStatus: "anon", lastKnownLocked: true })).toBe("lock");
    expect(overlayMode({ ...base, meStatus: "anon", lastKnownLocked: false })).toBe("pill");
  });

  it("opens the sign-in panel only on request and only when signed out", () => {
    expect(overlayMode({ ...base, meStatus: "anon", wantPanel: true })).toBe("panel");
    expect(overlayMode({ ...base, wantPanel: true })).toBe("pill");
  });
});
