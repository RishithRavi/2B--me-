import { describe, expect, it } from "vitest";

import { presenceWanted } from "@/components/site/presence-mount";
import { initialLiveState } from "@/lib/live";
import { modelBackendLabel, scoredModalities, unscoredLabel } from "@/lib/ui";

import type { RosterRow } from "@/lib/contracts";

import { drillTitle, liveLevel, stageLink } from "./dashboard-view";
import { agentOffline, needsResnapshot, type Drill } from "./live-hooks";
import { ttdView } from "./ttd-stopwatch";
import { redChip } from "./why-chips";

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

describe("why-chip alarm color follows the trust level", () => {
  const against = { against: true, z: -3.1 };
  it("is grey at Normal (and before any trust), red at Watch, Suspicious and Locked", () => {
    expect(redChip(against, "normal")).toBe(false);
    expect(redChip(against, null)).toBe(false);
    expect(redChip(against, "learning")).toBe(false);
    expect(redChip(against, "watch")).toBe(true);
    expect(redChip(against, "suspicious")).toBe(true);
    expect(redChip(against, "locked")).toBe(true);
  });
  it("needs a block that counted against the owner and |z| >= 2", () => {
    expect(redChip({ against: false, z: -3.1 }, "suspicious")).toBe(false);
    expect(redChip({ against: true, z: 1.4 }, "suspicious")).toBe(false);
  });
  it("liveLevel reports Locked for a locked device", () => {
    const s = initialLiveState();
    expect(liveLevel(s)).toBeNull();
    const device = { id: "d1", label: "Mac", pointer: "trackpad" as const, mode: "monitor" as const, locked: true, lock_reason: null, last_seen: null };
    expect(liveLevel({ ...s, device })).toBe("locked");
  });
});

describe("scored modalities (workflow and temporal are captured, not scored)", () => {
  it("follows the model's enabled set, else keyboard/mouse/scroll", () => {
    expect(scoredModalities(["mouse", "keyboard"])).toEqual(["keyboard", "mouse"]);
    expect(scoredModalities([])).toEqual(["keyboard", "mouse", "scroll"]);
    expect(scoredModalities(null)).toEqual(["keyboard", "mouse", "scroll"]);
  });
  it("names what is captured but not scored", () => {
    expect(unscoredLabel(["keyboard", "mouse", "scroll"])).toBe("Workflow, temporal");
    expect(unscoredLabel(["keyboard", "mouse", "scroll", "workflow", "temporal"])).toBeNull();
  });
});

describe("admin drill-in (synthetic employees are labelled; offline shows the last known value)", () => {
  const row = (over: Partial<RosterRow>): RosterRow =>
    ({ device_id: "e07", handle: "Employee 07", team: "People", synthetic: true, device_label: "MacBook Pro", online: true, last_seen: null, ...over }) as RosterRow;
  const drill = (over: Partial<RosterRow>): Drill => ({ deviceId: "e07", row: row(over), notFound: false });

  it("names a synthetic employee by handle and team, anything else by device label", () => {
    expect(drillTitle(drill({}), "MacBook Pro")).toBe("Employee 07 · People");
    expect(drillTitle(drill({ team: null }), "MacBook Pro")).toBe("Employee 07");
    expect(drillTitle(drill({ synthetic: false, handle: "A" }), "A's MacBook Pro")).toBe("A's MacBook Pro");
    expect(drillTitle(null, "A's MacBook Pro")).toBe("A's MacBook Pro");
    expect(drillTitle({ deviceId: "e07", row: null, notFound: false }, null)).toBeNull();
  });

  it("offline = live heartbeat 30 s or more (advanced since the report), else the roster's flag", () => {
    const now = 1_000_000;
    const health = (hb: number | null) => ({ heartbeat_age_s: hb }) as LiveStateHealth;
    expect(agentOffline({ health: health(2), healthAt: now }, null, now)).toBe(false);
    expect(agentOffline({ health: health(2), healthAt: now - 29_000 }, null, now)).toBe(true);
    expect(agentOffline({ health: health(45), healthAt: now }, drill({ online: true }), now)).toBe(true);
    // a live heartbeat wins over a stale roster poll
    expect(agentOffline({ health: health(1), healthAt: now }, drill({ online: false }), now)).toBe(false);
    expect(agentOffline({ health: null, healthAt: null }, drill({ online: false }), now)).toBe(true);
    expect(agentOffline({ health: null, healthAt: null }, null, now)).toBe(false);
  });
});

type LiveStateHealth = NonNullable<ReturnType<typeof initialLiveState>["health"]>;

describe("TTD view after a reload or a long takeover", () => {
  const T0 = Date.parse("2026-09-26T14:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const markers = [{ t: iso(T0), label: "takeover_start" as const, text: null }];
  const pt = (ms: number, confidence: number) => ({ t: iso(ms), confidence, level: (confidence < 0.4 ? "suspicious" : "normal") as "normal" });
  const blk = (modality: "keyboard" | "mouse", ms: number) => ({ modality, t_end: iso(ms) }) as never;

  it("counts are complete only when the blocks on hand start before the marker", () => {
    const history = [pt(T0 - 5000, 0.97), pt(T0 + 30_000, 0.35)];
    const all = ttdView(markers, history, [blk("keyboard", T0 - 1000), blk("keyboard", T0 + 5000), blk("mouse", T0 + 9000)], T0 + 60_000);
    expect(all.r.status).toBe("detected");
    expect(all.countsComplete).toBe(true);
    expect(all.beforeLoad).toBe(false);
    // after a reload the snapshot only carries the last 120 s of blocks
    const reloaded = ttdView(markers, history, [blk("mouse", T0 + 20_000)], T0 + 60_000);
    expect(reloaded.r.seconds).toBe(30);
    expect(reloaded.countsComplete).toBe(false);
  });

  it("says 'detected before this page loaded' when the history begins after the marker, already below 40%", () => {
    const v = ttdView(markers, [pt(T0 + 231_000, 0.2), pt(T0 + 236_000, 0.18)], [], T0 + 240_000);
    expect(v.r.status).toBe("detected");
    expect(v.beforeLoad).toBe(true);
    // history that starts after the marker but above 40% still times the real crossing
    expect(ttdView(markers, [pt(T0 + 10_000, 0.7), pt(T0 + 30_000, 0.35)], [], T0 + 40_000).beforeLoad).toBe(false);
  });
});
