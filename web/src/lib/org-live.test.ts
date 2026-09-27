import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuditRow, LiveEvent, RosterRow, TrustLive } from "./contracts";
import {
  ackedRefs,
  alertCounts,
  alertingDrops,
  alertRows,
  applyOrg,
  auditCsv,
  initialOrgState,
  levelDrops,
  mergeAudit,
  mergeRoster,
  normalizeRow,
  openAlerts,
  OrgStore,
  orgKpis,
  parseOrgEvent,
  rowLevel,
  sortRoster,
  SPARK_MAX,
  trustDisplay,
  type OrgState,
} from "./org-live";

const T0 = Date.UTC(2026, 8, 27, 14, 0, 0);
const DEV = "11111111-1111-4111-8111-111111111111";

function row(over: Partial<RosterRow> = {}): RosterRow {
  return {
    device_id: DEV,
    user_id: "22222222-2222-4222-8222-222222222222",
    handle: "Employee 01",
    team: "Finance",
    synthetic: true,
    device_label: "FIN-MBP14-01",
    online: true,
    last_seen: new Date(T0).toISOString(),
    mode: "monitor",
    level: "normal",
    confidence: 0.95,
    display: 95,
    locked: false,
    lock_reason: null,
    open_challenge: null,
    model_version: 3,
    model_backend: "twobme_ml",
    last_anomaly: null,
    last_anomaly_at: null,
    sparkline: [0.95],
    flags: [],
    ...over,
  };
}

function state(rows: RosterRow[] = [row()]): OrgState {
  return mergeRoster(initialOrgState(), rows, T0);
}

function trust(confidence: number, over: Partial<TrustLive> = {}, device = DEV): LiveEvent {
  return {
    type: "trust",
    device_id: device,
    t: new Date(T0 + 5000).toISOString(),
    data: {
      t: (T0 + 5000) / 1000,
      logit: Math.log(confidence / (1 - confidence)),
      delta_logit: 0,
      confidence,
      display: Math.round(confidence * 100),
      level: "normal",
      per_modality: {},
      reasons: [],
      seq: 1,
      locked: false,
      ...over,
    },
  };
}

function audit(id: string, minute: number, over: Partial<AuditRow> = {}): AuditRow {
  return {
    id,
    t: new Date(T0 + minute * 60_000).toISOString(),
    kind: "alert",
    device_id: DEV,
    user_id: null,
    handle: "Employee 01",
    actor: "system",
    summary: `row ${id}`,
    severity: 3,
    ref_id: null,
    ...over,
  };
}

describe("display and level stay consistent", () => {
  it("bands on the displayed percentage", () => {
    expect(trustDisplay(0.995)).toBe(99);
    expect(trustDisplay(0.7951)).toBe(80);
    expect(rowLevel({ locked: false, mode: "monitor", confidence: 0.7951 })).toBe("normal");
    expect(rowLevel({ locked: false, mode: "monitor", confidence: 0.3951 })).toBe("watch");
    expect(rowLevel({ locked: false, mode: "monitor", confidence: 0.3949 })).toBe("suspicious");
    expect(rowLevel({ locked: true, mode: "monitor", confidence: 0.99 })).toBe("locked");
    expect(rowLevel({ locked: false, mode: "enroll", confidence: 0.99 })).toBe("learning");
    expect(rowLevel({ locked: false, mode: "monitor", confidence: null })).toBe("learning");
  });

  it("normalizes a server row whose level came from the raw confidence", () => {
    const fixed = normalizeRow(row({ confidence: 0.398, display: 40, level: "suspicious" }));
    expect(fixed.display).toBe(40);
    expect(fixed.level).toBe("watch");
  });
});

describe("applyOrg", () => {
  it("applies a trust tick: confidence, display, level, sparkline, online", () => {
    const s = applyOrg(state([row({ online: false })]), trust(0.3949));
    const r = s.rows[0];
    expect(r.confidence).toBeCloseTo(0.3949);
    expect(r.display).toBe(39);
    expect(r.level).toBe("suspicious");
    expect(r.sparkline).toEqual([0.95, 0.3949]);
    expect(r.online).toBe(true);
    expect(r.last_seen).toBe(new Date(T0 + 5000).toISOString());
  });

  it("caps the sparkline at 5 minutes of ticks", () => {
    let s = state([row({ sparkline: Array.from({ length: SPARK_MAX }, () => 0.9) })]);
    s = applyOrg(s, trust(0.5));
    expect(s.rows[0].sparkline).toHaveLength(SPARK_MAX);
    expect(s.rows[0].sparkline.at(-1)).toBe(0.5);
  });

  it("marks the state stale for a device the roster doesn't know", () => {
    const s = applyOrg(state(), trust(0.9, {}, "99999999-9999-4999-8999-999999999999"));
    expect(s.stale).toBe(true);
    expect(s.rows[0].sparkline).toEqual([0.95]);
    expect(mergeRoster(s, [row()]).stale).toBe(false);
  });

  it("locks and unlocks; only an admin lock raises the admin_locked flag", () => {
    const lock = (reason: string): LiveEvent => ({ type: "lock", device_id: DEV, t: new Date(T0).toISOString(), data: { reason } });
    const unlock: LiveEvent = { type: "unlock", device_id: DEV, t: new Date(T0).toISOString(), data: {} };
    let s = applyOrg(state(), lock("admin_lock"));
    expect(s.rows[0]).toMatchObject({ locked: true, level: "locked", lock_reason: "admin_lock", flags: ["admin_locked"] });
    s = applyOrg(s, unlock);
    expect(s.rows[0]).toMatchObject({ locked: false, level: "normal", lock_reason: null, flags: [] });
    s = applyOrg(s, lock("voice_spoof"));
    expect(s.rows[0].flags).toEqual([]);
    expect(s.rows[0].level).toBe("locked");
    // A locked device's ticks keep it locked (the hub pins L).
    s = applyOrg(s, trust(0.2, { locked: true }));
    expect(s.rows[0]).toMatchObject({ locked: true, level: "locked", lock_reason: "voice_spoof" });
  });

  it("reads the lock reason off the trust push the hub sends before `lock` (no unexplained lock, no admin-lock toast)", () => {
    const lock = (reason: string): LiveEvent => ({ type: "lock", device_id: DEV, t: new Date(T0).toISOString(), data: { reason } });
    const levels = (st: OrgState) => new Map(st.rows.map((r) => [r.device_id, r.level]));

    // routers/admin.py admin_lock: trust(locked, ["admin_lock"]) → lock("admin_lock"), rendered frame by frame.
    let s = state([row({ confidence: 0.3, display: 30, level: "suspicious" })]);
    let prev = levels(s);
    s = applyOrg(s, trust(0.05, { locked: true, reasons: ["admin_lock"] }));
    expect(s.rows[0]).toMatchObject({ locked: true, level: "locked", lock_reason: "admin_lock", flags: ["admin_locked"] });
    const drops = levelDrops(prev, s.rows);
    expect(drops).toHaveLength(1);
    expect(alertingDrops(drops)).toEqual([]);
    prev = levels(s);
    s = applyOrg(s, lock("admin_lock"));
    expect(s.rows[0]).toMatchObject({ lock_reason: "admin_lock", flags: ["admin_locked"] });
    expect(levelDrops(prev, s.rows)).toEqual([]);

    // hub._blocked: trust(locked, ["voice_spoof"]) → lock("voice_spoof"); the toast carries the reason.
    s = state([row({ confidence: 0.3, display: 30, level: "suspicious" })]);
    prev = levels(s);
    s = applyOrg(s, trust(0.05, { locked: true, reasons: ["voice_spoof"] }));
    expect(s.rows[0]).toMatchObject({ locked: true, level: "locked", lock_reason: "voice_spoof", flags: [] });
    const voice = alertingDrops(levelDrops(prev, s.rows));
    expect(voice).toHaveLength(1);
    expect(voice[0].row.lock_reason).toBe("voice_spoof");

    // A reason already on a locked row is kept; unrelated reasons never invent one.
    s = applyOrg(s, trust(0.05, { locked: true, reasons: ["admin_lock"] }));
    expect(s.rows[0].lock_reason).toBe("voice_spoof");
    const bare = applyOrg(state(), trust(0.05, { locked: true, reasons: ["behavior_drift"] }));
    expect(bare.rows[0]).toMatchObject({ locked: true, level: "locked", lock_reason: null });
    // An admin unlock's trust push clears the lock and the admin flag.
    const cleared = applyOrg(applyOrg(state(), lock("admin_lock")), trust(0.9, { locked: false, reasons: ["admin_unlock"] }));
    expect(cleared.rows[0]).toMatchObject({ locked: false, lock_reason: null, flags: [], level: "normal" });
  });

  it("does not mark an offline device online from an admin lock or unlock push", () => {
    const seen = new Date(T0 - 42 * 60_000).toISOString();
    let s = state([row({ online: false, last_seen: seen })]);
    s = applyOrg(s, trust(0.9, { locked: true, reasons: ["admin_lock"] }));
    expect(s.rows[0]).toMatchObject({ online: false, last_seen: seen, locked: true });
    s = applyOrg(s, trust(0.9, { locked: false, reasons: ["admin_unlock"] }));
    expect(s.rows[0]).toMatchObject({ online: false, last_seen: seen, locked: false });
    s = applyOrg(s, trust(0.9));
    expect(s.rows[0].online).toBe(true);
  });

  it("tracks the open challenge and clears the takeover flag on VERIFY", () => {
    const ch = (status: "issued" | "verified" | "blocked_spoof"): LiveEvent => ({
      type: "challenge",
      device_id: DEV,
      t: new Date(T0).toISOString(),
      data: { challenge_id: "c1", trigger: "proactive", status, attempt: 1, expires_at: null, verify_url: null },
    });
    let s = applyOrg(
      state(),
      {
        type: "anomaly",
        device_id: DEV,
        t: new Date(T0).toISOString(),
        data: { id: "a1", kind: "takeover_suspected", severity: 4, trust_before: 0.9, trust_after: 0.3, top_features: [], action: null, challenge_id: null, explanation: null },
      },
    );
    expect(s.rows[0].flags).toEqual(["takeover_suspected"]);
    expect(s.rows[0].last_anomaly_at).toBe(new Date(T0).toISOString());
    s = applyOrg(s, ch("issued"));
    expect(s.rows[0].open_challenge?.status).toBe("issued");
    expect(s.rows[0].flags).toEqual(["takeover_suspected", "challenge_open"]);
    s = applyOrg(s, ch("verified"));
    expect(s.rows[0].open_challenge).toBeNull();
    expect(s.rows[0].flags).toEqual([]);
  });

  it("keeps a lock's pinned trust out of the sparkline (no fake crash to 0)", () => {
    const lock: LiveEvent = { type: "lock", device_id: DEV, t: new Date(T0).toISOString(), data: { reason: "admin_lock" } };
    const unlock: LiveEvent = { type: "unlock", device_id: DEV, t: new Date(T0).toISOString(), data: {} };
    let s = state([row({ sparkline: [0.95, 0.96] })]);
    s = applyOrg(s, trust(0.0001, { locked: true, reasons: ["admin_lock"] }));
    s = applyOrg(s, lock);
    s = applyOrg(s, trust(0.0001, { locked: true }));
    expect(s.rows[0]).toMatchObject({ locked: true, level: "locked", confidence: 0.0001, sparkline: [0.95, 0.96] });
    s = applyOrg(s, unlock);
    s = applyOrg(s, trust(0.96, { reasons: ["admin_unlock"] }));
    expect(s.rows[0].sparkline).toEqual([0.95, 0.96, 0.96]);
    expect(Math.min(...s.rows[0].sparkline)).toBeGreaterThan(0.9);
  });

  it("keeps the first-seen time when an anomaly is re-sent with the same id", () => {
    const a = (t: number, action: string | null): LiveEvent => ({
      type: "anomaly",
      device_id: DEV,
      t: new Date(t).toISOString(),
      data: { id: "a1", kind: "trust_drop", severity: 3, trust_before: 0.9, trust_after: 0.6, top_features: [], action, challenge_id: null, explanation: null },
    });
    let s = applyOrg(state(), a(T0, null));
    s = applyOrg(s, a(T0 + 10_000, "challenge_issued"));
    expect(s.rows[0].last_anomaly?.action).toBe("challenge_issued");
    expect(s.rows[0].last_anomaly_at).toBe(new Date(T0).toISOString());
  });

  it("flags remote sessions from decisions and presence", () => {
    const base = { decision_id: "d1", status: "pending" as const, decision: "step_up" as const, trans_status: "C" as const, confidence: 0.3, tier: "R3" as const, reasons: [], challenge_id: null, verify_url: null, action: "purchase" as const, amount_cents: 200000 };
    let s = applyOrg(state(), { type: "decision", device_id: DEV, t: new Date(T0).toISOString(), data: { ...base, binding: "remote" } });
    expect(s.rows[0].flags).toEqual(["remote_session"]);
    s = applyOrg(s, { type: "presence", device_id: DEV, t: new Date(T0).toISOString(), data: { binding: "co-present", score: 0.9 } });
    expect(s.rows[0].flags).toEqual([]);
  });

  it("switches enroll → monitor and picks up a new model version", () => {
    let s = state([row({ mode: "enroll", confidence: null, display: null, level: "learning", model_version: null, sparkline: [] })]);
    s = applyOrg(s, { type: "mode", device_id: DEV, t: new Date(T0).toISOString(), data: { mode: "monitor" } });
    expect(s.rows[0].level).toBe("learning");
    s = applyOrg(s, {
      type: "model",
      device_id: DEV,
      t: new Date(T0).toISOString(),
      data: { status: "ready", job_id: null, version: 1, trained_at: null, n_blocks: {}, enabled_modalities: [], metrics: {}, headline_medians: {}, learned_since_enroll: 0, parent_version: null, error: null, backend: "twobme_ml" },
    });
    s = applyOrg(s, trust(0.97));
    expect(s.rows[0]).toMatchObject({ mode: "monitor", model_version: 1, level: "normal", display: 97 });
  });

  it("merges audit rows newest first and dedupes by id", () => {
    let s = state();
    s = applyOrg(s, { type: "audit", device_id: DEV, t: "", data: audit("b", 2) });
    s = applyOrg(s, { type: "audit", device_id: DEV, t: "", data: audit("a", 1) });
    s = applyOrg(s, { type: "audit", device_id: DEV, t: "", data: audit("b", 2, { summary: "updated" }) });
    expect(s.audit.map((r) => r.id)).toEqual(["b", "a"]);
    expect(s.audit[0].summary).toBe("updated");
    expect(mergeAudit(s.audit, [audit("c", 0)]).map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("ignores demo labels (ground truth is never shown as a detection)", () => {
    const s0 = state();
    const s = applyOrg(s0, { type: "label", device_id: DEV, t: "", data: { label: "impostor", actor: "b" } });
    expect(s.rows).toBe(s0.rows);
  });
});

describe("parseOrgEvent", () => {
  it("accepts org event types including audit", () => {
    const ev = parseOrgEvent(JSON.stringify({ type: "audit", device_id: DEV, t: "2026-09-27T14:00:00Z", data: audit("x", 0) }));
    expect(ev?.type).toBe("audit");
  });
  it("drops types the panel doesn't use and garbage", () => {
    expect(parseOrgEvent(JSON.stringify({ type: "block_scored", device_id: DEV, data: {} }))).toBeNull();
    expect(parseOrgEvent("{nope")).toBeNull();
    expect(parseOrgEvent(JSON.stringify({ type: "trust" }))).toBeNull();
  });
});

describe("derived views", () => {
  it("counts KPIs", () => {
    const rows = [
      row({ device_id: "a", level: "normal" }),
      row({ device_id: "b", level: "watch", confidence: 0.6, display: 60 }),
      row({ device_id: "c", level: "suspicious", confidence: 0.2, display: 20, open_challenge: { challenge_id: "c", trigger: "proactive", status: "issued", attempt: 1, expires_at: null, verify_url: null } }),
      row({ device_id: "d", level: "locked", locked: true }),
      row({ device_id: "e", online: false }),
    ];
    const k = orgKpis(
      rows,
      [
        audit("1", -5, { device_id: "b", ref_id: "an-b" }),
        audit("2", -90, { device_id: "c", ref_id: "an-c" }),
        audit("3", -1, { device_id: "a", severity: 2 }),
        audit("4", -2, { kind: "admin_action", device_id: "d", severity: 4, summary: "Admin lock" }),
        audit("5", -3, { kind: "lock", device_id: "d", severity: 5 }),
      ],
      T0,
    );
    // Open: b (watch) and c (suspicious). a recovered (normal, no flags); d has no detection, only admin/lock rows.
    expect(k).toMatchObject({ total: 5, online: 4, atRisk: 2, suspicious: 1, watch: 1, locked: 1, openChallenges: 1, openAlerts: 2, alertsLastHour: 2, synthetic: 5 });
  });

  it("sorts the real device first, then by risk", () => {
    const rows = [
      row({ device_id: "n", handle: "Employee 02" }),
      row({ device_id: "off", handle: "Employee 03", online: false }),
      row({ device_id: "w", handle: "Employee 04", level: "watch", confidence: 0.6 }),
      row({ device_id: "l", handle: "Employee 05", locked: true, level: "locked" }),
      row({ device_id: "s", handle: "Employee 06", level: "suspicious", confidence: 0.2 }),
      row({ device_id: "a", handle: "a", synthetic: false }),
    ];
    expect(sortRoster(rows).map((r) => r.device_id)).toEqual(["a", "l", "s", "w", "n", "off"]);
    expect(sortRoster(rows, "name").map((r) => r.device_id)).toEqual(["a", "n", "off", "w", "l", "s"]);
  });

  it("orders equal displayed trust by name, whatever the raw confidence jitter", () => {
    const rows = [
      row({ device_id: "x", handle: "Employee 09", confidence: 0.9949, display: 99 }),
      row({ device_id: "y", handle: "Employee 02", confidence: 0.9951, display: 99 }),
      row({ device_id: "z", handle: "Employee 05", confidence: 0.97, display: 97 }),
    ];
    expect(sortRoster(rows).map((r) => r.device_id)).toEqual(["z", "y", "x"]);
    // The same rows a tick later with the jitter flipped: the order doesn't move.
    const flipped = rows.map((r) => (r.device_id === "x" ? { ...r, confidence: 0.9951 } : r.device_id === "y" ? { ...r, confidence: 0.9949 } : r));
    expect(sortRoster(flipped).map((r) => r.device_id)).toEqual(["z", "y", "x"]);
  });

  it("reports level drops only after the first load", () => {
    const rows = [row({ device_id: "x", level: "suspicious" }), row({ device_id: "y", level: "locked" }), row({ device_id: "z", level: "suspicious" })];
    expect(levelDrops(null, rows)).toEqual([]);
    const prev = new Map([
      ["x", "watch" as const],
      ["y", "suspicious" as const],
      ["z", "locked" as const],
    ]);
    expect(levelDrops(prev, rows).map((d) => [d.row.device_id, d.from, d.to])).toEqual([
      ["x", "watch", "suspicious"],
      ["y", "suspicious", "locked"],
    ]);
  });

  it("finds acknowledged alerts and the alerts rail", () => {
    const rows = [
      audit("1", 3, { kind: "admin_action", summary: "Acknowledged alert: trust drop", ref_id: "an1", severity: 1 }),
      audit("4", 3, { kind: "admin_action", summary: "ack_alert", ref_id: "an2", severity: 1 }),
      audit("5", 3, { kind: "admin_action", summary: "Locked the device", ref_id: "an3", severity: 4 }),
      audit("2", 2, { ref_id: "an1", severity: 4 }),
      audit("3", 1, { kind: "admin_action", summary: "Note: hi", ref_id: null, severity: 0 }),
    ];
    expect([...ackedRefs(rows).keys()].sort()).toEqual(["an1", "an2"]);
    // Detections only: admin actions (even a severity-4 lock) are never alerts.
    expect(alertRows(rows).map((r) => r.id)).toEqual(["2"]);
  });

  it("collapses re-armed detections to the newest per device and counts them", () => {
    const OTHER = "33333333-3333-4333-8333-333333333333";
    const trail = [
      audit("r3", -1, { ref_id: "an3", severity: 4 }),
      audit("x", -2, { kind: "challenge", ref_id: "c1", severity: 3 }),
      audit("o1", -3, { device_id: OTHER, handle: "Employee 02", ref_id: "ano", severity: 3 }),
      audit("r2", -4, { ref_id: "an2", severity: 4 }),
      audit("r1", -70, { ref_id: "an1", severity: 4 }),
    ];
    expect(alertRows(trail).map((r) => r.id)).toEqual(["r3", "o1"]);
    expect(alertCounts(trail, T0)).toEqual(new Map([[DEV, 2], [OTHER, 1]]));
  });

  it("opens an alert only while its device is still at risk and nobody acknowledged it", () => {
    const OTHER = "33333333-3333-4333-8333-333333333333";
    const trail = [
      audit("a1", -1, { ref_id: "an1", severity: 4 }),
      audit("o1", -2, { device_id: OTHER, ref_id: "ano", severity: 3 }),
    ];
    const risky = row({ level: "suspicious", confidence: 0.2, display: 20, flags: ["takeover_suspected"] });
    const fine = row({ device_id: OTHER, handle: "Employee 02" });
    const acked = (id: string) => new Map([[id, audit("k", 0, { kind: "admin_action", ref_id: id, summary: "Acknowledged alert: trust drop" })]]);
    expect(openAlerts(trail, new Map(), [risky, fine]).map((r) => r.id)).toEqual(["a1"]);
    expect(openAlerts(trail, acked("an1"), [risky, fine])).toEqual([]);
    // Flags alone keep it open (insider drift in the watch band, or a pending challenge), recovery resolves it.
    expect(openAlerts(trail, new Map(), [row({ flags: ["insider_drift"] }), fine]).map((r) => r.id)).toEqual(["a1"]);
    expect(openAlerts(trail, new Map(), [row(), fine])).toEqual([]);
  });

  it("exports CSV oldest first with escaping", () => {
    const csv = auditCsv([audit("2", 2, { summary: 'said "hi", then left' }), audit("1", 1)]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("time,employee,device_id,kind,actor,severity,summary,ref_id");
    expect(lines[1]).toContain("row 1");
    expect(lines[2]).toContain('"said ""hi"", then left"');
  });
});

describe("OrgStore (demo)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams the seeded org and applies admin actions to it", async () => {
    vi.useFakeTimers({ now: T0 });
    const store = new OrgStore("mock");
    let renders = 0;
    const unsub = store.subscribe(() => renders++);
    await vi.dynamicImportSettled();
    const first = store.getSnapshot();
    expect(first.loaded).toBe(true);
    expect(first.connected).toBe(true);
    expect(first.rows).toHaveLength(20);
    expect(first.audit.length).toBeGreaterThan(10);

    await vi.advanceTimersByTimeAsync(40_000);
    const s = store.getSnapshot();
    const e07 = s.rows.find((r) => r.handle === "Employee 07");
    expect(e07?.level).toBe("suspicious");
    expect(e07?.open_challenge).not.toBeNull();
    expect(s.rows.find((r) => r.handle === "Employee 13")?.flags).toContain("insider_drift");
    expect(renders).toBeGreaterThan(10);

    const e01 = s.rows.find((r) => r.handle === "Employee 01");
    const row = await store.act({ device_id: e01!.device_id, action: "lock" });
    expect(row.actor).toBe("demo admin");
    const after = store.getSnapshot();
    expect(after.rows.find((r) => r.handle === "Employee 01")).toMatchObject({ locked: true, flags: ["admin_locked"] });
    expect(after.audit[0].id).toBe(row.id);
    await expect(store.act({ device_id: e01!.device_id, action: "lock" })).rejects.toThrow(/already locked/);

    unsub();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.getSnapshot().connected).toBe(false);
  });
});
