import { describe, expect, it } from "vitest";

import { presenceWanted } from "@/components/site/presence-mount";
import { initialLiveState } from "@/lib/live";
import { modelBackendLabel } from "@/lib/ui";

import { stageLink } from "./dashboard-view";
import { needsResnapshot } from "./live-hooks";

describe("needsResnapshot (stream opened before the device existed)", () => {
  const s = { ...initialLiveState(), connected: true, synced: true };

  it("asks once events name a device while the snapshot had none", () => {
    expect(needsResnapshot(s, false)).toBeNull();
    const seen = { ...s, knownDevices: { d1: { id: "d1", label: "d1" } } };
    expect(needsResnapshot(seen, false)).toBe("d1");
  });

  it("never when the device is known, the stream is down, or in mock mode", () => {
    const seen = { ...s, knownDevices: { d1: { id: "d1", label: "d1" } } };
    const device = { id: "d1", label: "Mac", pointer: "trackpad" as const, mode: "monitor" as const, locked: false, lock_reason: null, last_seen: null };
    expect(needsResnapshot({ ...seen, device }, false)).toBeNull();
    expect(needsResnapshot({ ...seen, connected: false }, false)).toBeNull();
    // connected but this connection's snapshot hasn't arrived yet (e.g. right after a re-sign-in)
    expect(needsResnapshot({ ...seen, synced: false }, false)).toBeNull();
    expect(needsResnapshot(seen, true)).toBeNull();
  });
});

describe("stageLink", () => {
  it("keeps the admin's drill-in device", () => {
    expect(stageLink(false, "dev-1")).toBe("/dashboard?stage=1&device_id=dev-1");
    expect(stageLink(false, "dev-1", false)).toBe("/dashboard?device_id=dev-1");
    expect(stageLink(false, null, false)).toBe("/dashboard");
    expect(stageLink(true, "mock-device-a")).toBe("/dashboard?stage=1&mock=1");
  });
});

describe("modelBackendLabel", () => {
  it("names the scorer on the identity card", () => {
    expect(modelBackendLabel("twobme_ml")).toBe("one-class ensemble (twobme_ml)");
    expect(modelBackendLabel("fallback")).toBe("fallback (median/MAD)");
    expect(modelBackendLabel(null)).toBeNull();
    expect(modelBackendLabel("other")).toBe("other");
  });
});

describe("presenceWanted (root-layout co-presence beacon)", () => {
  const ok = { status: "ok", role: "user", pathname: "/shop", mock: false };
  it("beacons for a signed-in user on every page except the overlay", () => {
    expect(presenceWanted(ok)).toBe(true);
    expect(presenceWanted({ ...ok, pathname: "/" })).toBe(true);
    expect(presenceWanted({ ...ok, pathname: "/overlay" })).toBe(false);
  });
  it("never for admins (observers never anchor), signed-out users or mock mode", () => {
    expect(presenceWanted({ ...ok, role: "admin" })).toBe(false);
    expect(presenceWanted({ ...ok, status: "anon" })).toBe(false);
    expect(presenceWanted({ ...ok, status: "loading" })).toBe(false);
    expect(presenceWanted({ ...ok, mock: true })).toBe(false);
  });
});
