import { describe, expect, it } from "vitest";

import { ACTIVE_MODALITIES, createOrgSim, ORG_SIZE, STEP_MS } from "./admin-mock";
import { FEATURE_SPEC, type Level, type LiveEvent, type RosterRow } from "./contracts";
import {
  AUDIT_KINDS,
  alertingDrops,
  applyOrg,
  initialOrgState,
  levelDrops,
  mergeAudit,
  mergeRoster,
  rowLevel,
  trustDisplay,
  type LevelDrop,
  type OrgState,
} from "./org-live";

const T0 = Date.UTC(2026, 8, 27, 14, 0, 0);

function run(seed: number, steps: number) {
  const sim = createOrgSim({ seed, now: T0 });
  const events: LiveEvent[] = [];
  for (let s = 1; s <= steps; s++) events.push(...sim.step(T0 + s * STEP_MS));
  return { sim, events };
}

const byHandle = (rows: RosterRow[], handle: string) => {
  const r = rows.find((x) => x.handle === handle);
  if (!r) throw new Error(`no ${handle}`);
  return r;
};

/** Run the simulation step by step, returning the roster after each step. */
function timeline(steps: number, seed = 1) {
  const sim = createOrgSim({ seed, now: T0 });
  const frames: RosterRow[][] = [sim.roster()];
  for (let s = 1; s <= steps; s++) {
    sim.step(T0 + s * STEP_MS);
    frames.push(sim.roster());
  }
  return { sim, frames };
}

const SPEC = new Map<string, { label: string; unit: string }>();
for (const m of Object.values(FEATURE_SPEC.modalities)) for (const f of m.features) SPEC.set(f.name, { label: f.label, unit: f.unit });

describe("org simulation: determinism", () => {
  it("replays identically for the same seed", () => {
    const a = run(42, 150);
    const b = run(42, 150);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(a.sim.roster()).toEqual(b.sim.roster());
    expect(a.sim.audit()).toEqual(b.sim.audit());
  });

  it("changes the noise but not the story for another seed", () => {
    const a = run(1, 30).sim.roster();
    const b = run(2, 30).sim.roster();
    expect(a.map((r) => r.confidence)).not.toEqual(b.map((r) => r.confidence));
    expect(byHandle(a, "Employee 07").level).toBe(byHandle(b, "Employee 07").level);
  });
});

describe("org simulation: consistency", () => {
  it("has 20 anonymized employees with unique pseudonyms and devices", () => {
    const rows = createOrgSim({ now: T0 }).roster();
    expect(rows).toHaveLength(ORG_SIZE);
    expect(ORG_SIZE).toBe(20);
    expect(new Set(rows.map((r) => r.handle)).size).toBe(rows.length);
    expect(new Set(rows.map((r) => r.device_id)).size).toBe(rows.length);
    expect(new Set(rows.map((r) => r.device_label)).size).toBe(rows.length);
    for (const r of rows) {
      expect(r.handle).toMatch(/^Employee \d{2}$/);
      expect(r.synthetic).toBe(true);
      expect(r.device_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it("always derives the level from the displayed %", () => {
    const { frames } = timeline(200);
    for (const rows of frames) {
      for (const r of rows) {
        expect(r.display).toBe(r.confidence === null ? null : trustDisplay(r.confidence));
        expect(r.level).toBe(rowLevel(r));
        for (const c of r.sparkline) expect(c).toBeGreaterThanOrEqual(0);
        expect(r.sparkline.length).toBeLessThanOrEqual(60);
      }
    }
  });

  it("uses only FEATURE_SPEC names, labels and units", () => {
    const { events, sim } = run(3, 200);
    const devs = [
      ...events.flatMap((e) => (e.type === "anomaly" ? e.data.top_features : [])),
      ...sim.roster().flatMap((r) => r.last_anomaly?.top_features ?? []),
      ...createOrgSim({ now: T0 }).roster().flatMap((r) => r.last_anomaly?.top_features ?? []),
    ];
    expect(devs.length).toBeGreaterThan(3);
    for (const d of devs) {
      expect(SPEC.get(d.feature), d.feature).toEqual({ label: d.label, unit: d.unit });
    }
  });

  it("only tells stories the live identity model can produce (keyboard, mouse and scroll)", () => {
    const { events, sim } = run(3, 200);
    const devs = [
      ...events.flatMap((e) => (e.type === "anomaly" ? e.data.top_features : [])),
      ...sim.roster().flatMap((r) => r.last_anomaly?.top_features ?? []),
      ...createOrgSim({ now: T0 }).roster().flatMap((r) => r.last_anomaly?.top_features ?? []),
    ];
    const insider = byHandle(sim.roster(), "Employee 13").last_anomaly;
    expect(insider?.top_features.length).toBeGreaterThan(0);
    for (const d of devs) expect(d.feature, d.feature).toMatch(/^(kb|ms|sc)\./);
    const text = [...events.flatMap((e) => (e.type === "anomaly" ? [e.data.explanation ?? ""] : [])), ...sim.audit().map((r) => r.summary)].join("\n");
    expect(text).not.toMatch(/workflow|temporal|app switch|idle/i);
    const models = events.flatMap((e) => (e.type === "model" ? [e.data] : []));
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.enabled_modalities).toEqual([...ACTIVE_MODALITIES]);
      expect(Object.keys(m.n_blocks).sort()).toEqual([...ACTIVE_MODALITIES].sort());
    }
  });

  it("starts with a varied, ordered audit trail", () => {
    const audit = createOrgSim({ now: T0 }).audit();
    const kinds = new Set(audit.map((r) => r.kind));
    for (const k of AUDIT_KINDS) expect(kinds.has(k), k).toBe(true);
    expect(new Set(audit.map((r) => r.summary)).size).toBeGreaterThan(audit.length - 3);
    expect(new Set(audit.map((r) => r.id)).size).toBe(audit.length);
    for (let i = 1; i < audit.length; i++) expect(Date.parse(audit[i - 1].t)).toBeGreaterThanOrEqual(Date.parse(audit[i].t));
    for (const r of audit) {
      expect(r.severity).toBeGreaterThanOrEqual(0);
      expect(r.severity).toBeLessThanOrEqual(5);
      expect(Date.parse(r.t)).toBeLessThanOrEqual(T0);
    }
    expect(audit.filter((r) => r.severity >= 3).length).toBeGreaterThan(0);
  });
});

describe("org simulation: the story", () => {
  it("escalates a takeover on Employee 07: watch → suspicious + alert → challenge → locked → owner unlock", () => {
    const { frames } = timeline(80);
    const at = (s: number) => byHandle(frames[s], "Employee 07");
    expect(at(0).level).toBe("normal");
    const firstWatch = frames.findIndex((rows) => byHandle(rows, "Employee 07").level === "watch");
    const firstSusp = frames.findIndex((rows) => byHandle(rows, "Employee 07").level === "suspicious");
    const firstChallenge = frames.findIndex((rows) => byHandle(rows, "Employee 07").open_challenge !== null);
    const firstLock = frames.findIndex((rows) => byHandle(rows, "Employee 07").locked);
    expect(firstWatch).toBeGreaterThan(0);
    expect(firstSusp).toBeGreaterThan(firstWatch);
    expect(firstSusp * STEP_MS).toBeLessThanOrEqual(32_000);
    expect(at(firstSusp).flags).toContain("takeover_suspected");
    expect(at(firstSusp).last_anomaly?.kind).toBe("takeover_suspected");
    expect(firstChallenge).toBeGreaterThan(firstSusp - 1);
    expect(firstChallenge * STEP_MS).toBeLessThanOrEqual(38_000);
    expect(at(firstChallenge).flags).toContain("challenge_open");
    expect(firstLock).toBeGreaterThan(firstChallenge);
    expect(at(firstLock).lock_reason).toBe("voice_spoof");
    expect(at(firstLock).flags).not.toContain("challenge_open");
    // ~40 s in (the stage screenshot), 07 is suspicious with its voice check open.
    expect(at(16)).toMatchObject({ level: "suspicious" });
    expect(at(16).open_challenge).not.toBeNull();
    // The owner comes back and unlocks with voice.
    const last = at(80);
    expect(last.locked).toBe(false);
    expect(last.display).toBeGreaterThanOrEqual(90);
    expect(last.level).toBe("normal");
    expect(last.flags).not.toContain("takeover_suspected");
  });

  it("drifts Employee 13 into watch with the insider-drift flag", () => {
    const { frames } = timeline(40);
    const first = frames.findIndex((rows) => byHandle(rows, "Employee 13").level === "watch");
    expect(first).toBeGreaterThan(0);
    expect(first * STEP_MS).toBeLessThanOrEqual(30_000);
    const r = byHandle(frames[40], "Employee 13");
    expect(r.level).toBe("watch");
    expect(r.flags).toContain("insider_drift");
    expect(r.last_anomaly?.kind).toBe("trust_drop");
  });

  it("flags a remote session on Employee 04 and runs its step-up to N", () => {
    const { frames, sim } = timeline(40);
    expect(byHandle(frames[0], "Employee 04").flags).toContain("remote_session");
    expect(byHandle(frames[8], "Employee 04").open_challenge?.trigger).toBe("step_up");
    expect(byHandle(frames[40], "Employee 04").open_challenge).toBeNull();
    expect(sim.audit().some((r) => r.handle === "Employee 04" && /declined \(N\)/.test(r.summary))).toBe(true);
  });

  it("covers the other states judges should see", () => {
    const { frames } = timeline(44);
    const start = frames[0];
    expect(byHandle(start, "Employee 12")).toMatchObject({ locked: true, lock_reason: "admin_lock", flags: ["admin_locked"] });
    expect(byHandle(start, "Employee 18").online).toBe(false);
    expect(byHandle(start, "Employee 19")).toMatchObject({ level: "learning", mode: "enroll", display: null });
    expect(byHandle(start, "Employee 20").online).toBe(false);
    expect(byHandle(frames[30], "Employee 20").online).toBe(true);
    expect(byHandle(frames[44], "Employee 19")).toMatchObject({ mode: "monitor", model_version: 1, level: "normal" });
  });
});

describe("org simulation: admin actions", () => {
  it("locks, refuses to clear a voice lock, and clears an admin lock", () => {
    const sim = createOrgSim({ now: T0 });
    const e01 = byHandle(sim.roster(), "Employee 01");
    const { row, events } = sim.act({ device_id: e01.device_id, action: "lock" }, T0 + 1000, "tester");
    expect(row).toMatchObject({ kind: "admin_action", actor: "tester", handle: "Employee 01", severity: 4 });
    // Hub order (routers/admin.py): trust(locked, ["admin_lock"]) before the lock event.
    expect(events.map((e) => e.type)).toEqual(["trust", "lock", "audit"]);
    const push = events[0];
    expect(push.type === "trust" && push.data).toMatchObject({ locked: true, reasons: ["admin_lock"] });
    expect(byHandle(sim.roster(), "Employee 01")).toMatchObject({ locked: true, level: "locked", flags: ["admin_locked"] });
    const cleared = sim.act({ device_id: e01.device_id, action: "unlock" }, T0 + 2000, "tester");
    expect(cleared.events.map((e) => e.type)).toEqual(["unlock", "trust", "audit"]);
    expect(byHandle(sim.roster(), "Employee 01")).toMatchObject({ locked: false, flags: [] });

    // Let 07 get blocked, then try to clear its voice lock.
    for (let s = 1; s <= 30; s++) sim.step(T0 + s * STEP_MS);
    const e07 = byHandle(sim.roster(), "Employee 07");
    expect(e07.locked).toBe(true);
    expect(() => sim.act({ device_id: e07.device_id, action: "unlock" }, T0, "tester")).toThrow(/voice/);
  });

  it("force re-verify issues a challenge that the genuine owner passes", () => {
    const sim = createOrgSim({ now: T0 });
    const e03 = byHandle(sim.roster(), "Employee 03");
    sim.act({ device_id: e03.device_id, action: "force_reverify" }, T0, "tester");
    expect(byHandle(sim.roster(), "Employee 03").open_challenge?.trigger).toBe("proactive");
    expect(() => sim.act({ device_id: e03.device_id, action: "force_reverify" }, T0, "tester")).toThrow(/open challenge/);
    for (let s = 1; s <= 9; s++) sim.step(T0 + s * STEP_MS);
    const r = byHandle(sim.roster(), "Employee 03");
    expect(r.open_challenge).toBeNull();
    expect(r.sparkline.some((c) => Math.abs(c - 0.97) < 1e-9)).toBe(true);
    expect(sim.audit().some((a) => a.handle === "Employee 03" && /VERIFY/.test(a.summary))).toBe(true);
  });

  it("acknowledges an alert by anomaly id and records notes", () => {
    const sim = createOrgSim({ now: T0 });
    const e10 = byHandle(sim.roster(), "Employee 10");
    const ack = sim.act({ device_id: e10.device_id, action: "ack_alert", anomaly_id: e10.last_anomaly?.id }, T0, "tester");
    expect(ack.row.ref_id).toBe(e10.last_anomaly?.id);
    expect(ack.row.summary).toMatch(/^Acknowledged alert/);
    const note = sim.act({ device_id: e10.device_id, action: "note", text: "  called the employee  " }, T0, "tester");
    expect(note.row.summary).toBe("Note: “called the employee”");
    expect(() => sim.act({ device_id: e10.device_id, action: "note", text: " " }, T0, "tester")).toThrow();
  });
});

describe("reducer parity with the simulation", () => {
  it("applyOrg over the event stream reproduces the simulated roster", () => {
    const sim = createOrgSim({ seed: 9, now: T0 });
    let s: OrgState = mergeRoster(initialOrgState(), sim.roster(), T0);
    s = { ...s, audit: mergeAudit([], sim.audit()) };
    const e13 = byHandle(sim.roster(), "Employee 13").device_id;
    for (let k = 1; k <= 180; k++) {
      const now = T0 + k * STEP_MS;
      if (k === 50) {
        const e05 = byHandle(sim.roster(), "Employee 05").device_id;
        for (const ev of sim.act({ device_id: e05, action: "lock" }, now, "t").events) s = applyOrg(s, ev, now);
      }
      if (k === 60) for (const ev of sim.act({ device_id: e13, action: "force_reverify" }, now, "t").events) s = applyOrg(s, ev, now);
      // An admin lock and unlock of an offline device must not bring it online.
      if (k === 70 || k === 90) {
        const e18 = byHandle(sim.roster(), "Employee 18").device_id;
        for (const ev of sim.act({ device_id: e18, action: k === 70 ? "lock" : "unlock" }, now, "t").events) s = applyOrg(s, ev, now);
      }
      if (k === 100) {
        const e05 = byHandle(sim.roster(), "Employee 05").device_id;
        for (const ev of sim.act({ device_id: e05, action: "unlock" }, now, "t").events) s = applyOrg(s, ev, now);
      }
      for (const ev of sim.step(now)) s = applyOrg(s, ev, now);
    }
    const truth = sim.roster();
    const pick = (r: RosterRow) => ({
      handle: r.handle,
      online: r.online,
      mode: r.mode,
      level: r.level,
      confidence: r.confidence,
      display: r.display,
      locked: r.locked,
      lock_reason: r.lock_reason,
      open_challenge: r.open_challenge,
      model_version: r.model_version,
      last_anomaly_id: r.last_anomaly?.id ?? null,
      last_anomaly_at: r.last_anomaly_at,
      sparkline: r.sparkline,
      // insider_drift is a server-side heuristic no event carries; the roster re-sync reconciles it.
      flags: r.flags.filter((f) => f !== "insider_drift"),
    });
    expect(s.rows.map(pick)).toEqual(truth.map(pick));
    expect(byHandle(s.rows, "Employee 18").online).toBe(false);
    // Every audit row the simulation logged arrived through the stream.
    const ids = new Set(s.audit.map((r) => r.id));
    for (const r of sim.audit()) expect(ids.has(r.id)).toBe(true);
  });

  it("toasts the voice lock with its reason and never the admin's own lock, event by event", () => {
    const sim = createOrgSim({ seed: 5, now: T0 });
    let s: OrgState = mergeRoster(initialOrgState(), sim.roster(), T0);
    let prev: Map<string, Level> = new Map(s.rows.map((r) => [r.device_id, r.level]));
    const toasts: LevelDrop[] = [];
    // Each websocket frame can render on its own: check the drops after every single event.
    const feed = (events: LiveEvent[], now: number) => {
      for (const ev of events) {
        s = applyOrg(s, ev, now);
        toasts.push(...alertingDrops(levelDrops(prev, s.rows)));
        prev = new Map(s.rows.map((r) => [r.device_id, r.level]));
      }
    };
    const e02 = byHandle(sim.roster(), "Employee 02").device_id;
    for (let k = 1; k <= 30; k++) {
      const now = T0 + k * STEP_MS;
      if (k === 4) feed(sim.act({ device_id: e02, action: "lock" }, now, "t").events, now);
      feed(sim.step(now), now);
    }
    expect(byHandle(s.rows, "Employee 02")).toMatchObject({ locked: true, lock_reason: "admin_lock" });
    expect(toasts.some((d) => d.row.handle === "Employee 02")).toBe(false);
    const locked07 = toasts.filter((d) => d.row.handle === "Employee 07" && d.to === "locked");
    expect(locked07).toHaveLength(1);
    expect(locked07[0].row.lock_reason).toBe("voice_spoof");
    for (const d of toasts) if (d.to === "locked") expect(d.row.lock_reason).not.toBeNull();
  });
});
