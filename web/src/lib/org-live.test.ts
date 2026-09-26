import { describe, expect, it } from "vitest";

import type { AuditRow, LiveEvent, RosterRow, TrustLive } from "./contracts";
import {
  ackedRefs,
  alertRows,
  applyOrg,
  auditCsv,
  initialOrgState,
  levelDrops,
  mergeAudit,
  mergeRoster,
  normalizeRow,
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
    s = applyOrg(s, lock("blocked_spoof"));
    expect(s.rows[0].flags).toEqual([]);
    expect(s.rows[0].level).toBe("locked");
    // A locked device's ticks keep it locked (the hub pins L).
    s = applyOrg(s, trust(0.2, { locked: true }));
    expect(s.rows[0]).toMatchObject({ locked: true, level: "locked", lock_reason: "blocked_spoof" });
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
    const k = orgKpis(rows, [audit("1", -5), audit("2", -90), audit("3", -1, { severity: 1 })], T0);
    expect(k).toMatchObject({ total: 5, online: 4, atRisk: 2, suspicious: 1, watch: 1, locked: 1, openChallenges: 1, alertsLastHour: 1, synthetic: 5 });
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
      audit("2", 2, { ref_id: "an1", severity: 4 }),
      audit("3", 1, { kind: "admin_action", summary: "Note: hi", ref_id: null, severity: 0 }),
    ];
    expect([...ackedRefs(rows).keys()]).toEqual(["an1"]);
    expect(alertRows(rows).map((r) => r.id)).toEqual(["2"]);
  });

  it("exports CSV oldest first with escaping", () => {
    const csv = auditCsv([audit("2", 2, { summary: 'said "hi", then left' }), audit("1", 1)]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("time,employee,device_id,kind,actor,severity,summary,ref_id");
    expect(lines[1]).toContain("row 1");
    expect(lines[2]).toContain('"said ""hi"", then left"');
  });
});
