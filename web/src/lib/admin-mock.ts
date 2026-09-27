// Synthetic, anonymized org for the admin panel's demo mode (§2.4, newGoal: "synthetic sessions of ~20 employees
// whose information is first anonymized"). Nothing here is a real person, device or behavioral recording.
//
// Deterministic by construction: a seeded RNG (mulberry32) and a step counter drive a scripted story, and wall-clock
// time only stamps the events. It emits exactly what the real backend emits — RosterRow[] (GET /api/admin/roster),
// AuditRow[] (GET /api/admin/audit) and LiveEvent envelopes (/ws/live?scope=org) — so lib/org-live.ts runs one
// reducer for both. The story (every step is 2.5 s; each employee ticks every 5 s):
//   · Employee 07 (Finance): a takeover at ~8 s → Watch → Suspicious (~30 s, alert) → proactive voice check (~35 s)
//     → synthetic voice blocked, device locked (~55 s) → the owner unlocks with voice (~3 min); repeats every 4 min.
//   · Employee 13 (Engineering): slow insider drift into Watch (~25 s) with an insider-drift alert; voice would
//     verify it IS the employee, which is the point of insider-threat review.
//   · Employee 04 (Finance): a remote browser session (not co-present) tries a $2,000 purchase → step-up C → expires N.
//   · Employee 12 (Legal) is admin-locked on arrival; 18 is offline; 20 signs in at ~60 s; 19 finishes enrollment
//     at ~100 s; 11 dips into Watch and recovers without a challenge (behavior alone never blocks).
// Admin actions (lock, clear lock, force re-verify, acknowledge, note) act on the simulation and emit the same events.
import {
  FEATURE_SPEC,
  TRUST_CONFIG,
  type AdminActionIn,
  type AnomalyKind,
  type AnomalyLive,
  type AuditKind,
  type AuditRow,
  type ChallengeLive,
  type ChallengeTrigger,
  type DecisionLive,
  type DeviationOut,
  type LiveEvent,
  type Mode,
  type ModelInfo,
  type RosterRow,
  type TrustLive,
  type VoiceDecision,
} from "./contracts";
import { DEMO_ACTOR, SPARK_MAX, orderFlags, rowLevel, setFlag, trustDisplay, type OrgFlag, type OrgSimLike } from "./org-live";
import { levelLabel } from "./ui";

export const ORG_SEED = 20260927;
export const STEP_MS = 2500;
/** Steps between two ticks of one employee (5 s ticks, like the agent). */
const TICK_EVERY = 2;

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussFrom(rng: () => number): number {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function uuidFrom(rng: () => number): string {
  const h = (n: number) =>
    Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join("");
  const variant = (8 + Math.floor(rng() * 4)).toString(16);
  return `${h(8)}-${h(4)}-4${h(3)}-${variant}${h(3)}-${h(12)}`;
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const L_CAP = logit(TRUST_CONFIG.cap);
const clampL = (x: number) => Math.max(-L_CAP, Math.min(L_CAP, x));
const iso = (ms: number) => new Date(ms).toISOString();
const round1 = (x: number) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------------------
// Feature deviations: names, labels and units only from the frozen FEATURE_SPEC
// ---------------------------------------------------------------------------

const SPEC_FEATURES = new Map<string, { label: string; unit: string }>();
for (const spec of Object.values(FEATURE_SPEC.modalities)) {
  for (const f of spec.features) SPEC_FEATURES.set(f.name, { label: f.label, unit: f.unit });
}

function deviation(name: string, z: number): DeviationOut {
  const meta = SPEC_FEATURES.get(name);
  if (!meta) throw new Error(`admin-mock: ${name} is not in FEATURE_SPEC`);
  return { feature: name, label: meta.label, unit: meta.unit, z: round1(z) };
}

const TAKEOVER_SIGNATURE: [string, number][] = [
  ["kb.dd_p50", 3.1],
  ["ms.curv_p50", 2.6],
  ["kb.hold_p50", -2.2],
];
// Identity models score keyboard, mouse and scroll only (twobme_ml ACTIVE_MODALITIES; workflow and temporal were
// retired), so the drift is told in those signals too: more hesitation, not a different pair of hands.
const INSIDER_SIGNATURE: [string, number][] = [
  ["kb.pause_rate", 2.3],
  ["ms.pre_click_pause_p50", 1.9],
  ["kb.bksp_rate", 1.6],
];
/** The modalities a live identity model scores (twobme_ml ACTIVE_MODALITIES). */
export const ACTIVE_MODALITIES = ["keyboard", "mouse", "scroll"] as const;

function fmtDevs(devs: DeviationOut[]): string {
  return devs.map((d) => `${d.label} ${d.z >= 0 ? "+" : "−"}${Math.abs(d.z).toFixed(1)}σ`).join(", ");
}

// ---------------------------------------------------------------------------
// The org
// ---------------------------------------------------------------------------

export const ORG_TEAMS = ["Finance", "Engineering", "Sales", "Support", "Operations", "Legal"] as const;
type Team = (typeof ORG_TEAMS)[number];
const TEAM_CODE: Record<Team, string> = {
  Finance: "FIN",
  Engineering: "ENG",
  Sales: "SLS",
  Support: "SUP",
  Operations: "OPS",
  Legal: "LGL",
};

type Role = "steady" | "takeover" | "insider" | "remote" | "dip" | "learning" | "offline" | "late" | "held";

interface Plan {
  team: Team;
  kit: string;
  role: Role;
  base: number;
  model: number | null;
}

// One line per employee (Employee 01 … 20). Handles are sequential, so no pseudonym can repeat.
const PLAN: readonly Plan[] = [
  { team: "Finance", kit: "MBP14", role: "steady", base: 0.96, model: 9 },
  { team: "Engineering", kit: "MBP16", role: "steady", base: 0.97, model: 8 },
  { team: "Sales", kit: "MBA13", role: "steady", base: 0.95, model: 5 },
  { team: "Finance", kit: "MBA15", role: "remote", base: 0.94, model: 6 },
  { team: "Support", kit: "MBA13", role: "steady", base: 0.93, model: 4 },
  { team: "Engineering", kit: "MBP14", role: "steady", base: 0.98, model: 11 },
  { team: "Finance", kit: "MBP14", role: "takeover", base: 0.96, model: 7 },
  { team: "Operations", kit: "MBP14", role: "steady", base: 0.91, model: 3 },
  { team: "Engineering", kit: "MBP16", role: "steady", base: 0.96, model: 6 },
  { team: "Sales", kit: "MBA15", role: "steady", base: 0.94, model: 5 },
  { team: "Support", kit: "MBA13", role: "dip", base: 0.95, model: 4 },
  { team: "Legal", kit: "MBP14", role: "held", base: 0.93, model: 6 },
  { team: "Engineering", kit: "MBP16", role: "insider", base: 0.84, model: 10 },
  { team: "Operations", kit: "MBA13", role: "steady", base: 0.95, model: 4 },
  { team: "Sales", kit: "MBP14", role: "steady", base: 0.93, model: 5 },
  { team: "Finance", kit: "MBA15", role: "steady", base: 0.96, model: 7 },
  { team: "Support", kit: "MBA13", role: "steady", base: 0.94, model: 3 },
  { team: "Legal", kit: "MBA13", role: "offline", base: 0.95, model: 5 },
  { team: "Engineering", kit: "MBP14", role: "learning", base: 0.96, model: null },
  { team: "Operations", kit: "MBA15", role: "late", base: 0.95, model: 6 },
];

export const ORG_SIZE = PLAN.length;

const TAKEOVER_CYCLE = 96; // 4 min
const TAKEOVER_START = 3;
const OWNER_RETURNS = 64;
const REMOTE_CYCLE = 120; // 5 min
const REMOTE_ATTEMPT = 6;
const DIP_CYCLE = 80;
const LATE_SIGN_IN = 24;
const ENROLL_DONE = 40;
const VOICE_STEPS = { prompt_ended: 2, scoring: 5, result: 8 } as const;
const STEP_UP_EXPIRES = 28;
const INSIDER_FLOOR = 0.6;
const INSIDER_SLOPE = 0.012;

interface SimChallenge {
  live: ChallengeLive;
  issued: number;
  /** null = decided at result time from who is really at the keyboard */
  outcome: VoiceDecision | "EXPIRE" | null;
  decision: DecisionLive | null;
}

interface Emp {
  i: number;
  plan: Plan;
  handle: string;
  team: Team;
  device_id: string;
  user_id: string;
  device_label: string;
  base: number;
  L: number;
  mode: Mode;
  online: boolean;
  lastSeen: number;
  locked: boolean;
  lockReason: string | null;
  challenge: SimChallenge | null;
  anomaly: AnomalyLive | null;
  anomalyAt: string | null;
  spark: number[];
  flags: string[];
  /** ground truth: someone else is at the keyboard (never shown to the admin) */
  compromised: boolean;
  /** a takeover alert has fired for the current low-trust episode */
  alarmed: boolean;
  below: number;
  modelVersion: number | null;
  seq: number;
}

export interface OrgSim extends OrgSimLike {
  readonly steps: number;
}

export interface OrgSimOptions {
  seed?: number;
  /** wall-clock ms of the simulation start (tests pass a fixed value) */
  now?: number;
}

const DEFAULT_T0 = Date.UTC(2026, 8, 27, 14, 0, 0);

export function createOrgSim(opts: OrgSimOptions = {}): OrgSim {
  return new Sim(opts.seed ?? ORG_SEED, opts.now ?? DEFAULT_T0);
}

class Sim implements OrgSim {
  readonly stepMs = STEP_MS;
  private stepCount = 0;
  private readonly rng: () => number;
  private readonly idRng: () => number;
  private readonly emps: Emp[];
  private log: AuditRow[] = [];

  constructor(seed: number, t0: number) {
    this.rng = mulberry32(seed);
    this.idRng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
    this.emps = PLAN.map((plan, i) => this.makeEmp(plan, i, t0));
    this.backfillAudit(t0);
  }

  get steps(): number {
    return this.stepCount;
  }

  private gauss(): number {
    return gaussFrom(this.rng);
  }

  private id(): string {
    return uuidFrom(this.idRng);
  }

  // ---- construction --------------------------------------------------------

  private makeEmp(plan: Plan, i: number, t0: number): Emp {
    const nn = String(i + 1).padStart(2, "0");
    const offline = plan.role === "offline" || plan.role === "late";
    const lastSeen = plan.role === "offline" ? t0 - 42 * 60_000 : plan.role === "late" ? t0 - 190 * 60_000 : t0 - (i % TICK_EVERY) * STEP_MS;
    const learning = plan.role === "learning";
    // Backfill the last 5 min of ticks (an Ornstein–Uhlenbeck walk in logit space around the baseline).
    const spark: number[] = [];
    if (!learning) {
      let L = logit(plan.base);
      for (let k = 0; k < SPARK_MAX; k++) {
        if (plan.role === "insider") {
          const target = 0.93 - ((0.93 - plan.base) * k) / (SPARK_MAX - 1);
          L = logit(target) + 0.04 * this.gauss();
        } else {
          L = clampL(L + 0.35 * (logit(plan.base) - L) + 0.1 * this.gauss());
        }
        spark.push(sigmoid(L));
      }
    }
    const last = spark.length ? spark[spark.length - 1] : plan.base;
    const emp: Emp = {
      i,
      plan,
      handle: `Employee ${nn}`,
      team: plan.team,
      device_id: this.id(),
      user_id: this.id(),
      device_label: `${TEAM_CODE[plan.team]}-${plan.kit}-${nn}`,
      base: plan.base,
      L: logit(last),
      mode: learning ? "enroll" : "monitor",
      online: !offline,
      lastSeen,
      locked: plan.role === "held",
      lockReason: plan.role === "held" ? "admin_lock" : null,
      challenge: null,
      anomaly: null,
      anomalyAt: null,
      spark,
      flags: [],
      compromised: false,
      alarmed: false,
      below: 0,
      modelVersion: plan.model,
      seq: 0,
    };
    if (plan.role === "remote") emp.flags = setFlag(emp.flags, "remote_session", true);
    if (plan.role === "held") emp.flags = setFlag(emp.flags, "admin_locked", true);
    return emp;
  }

  private emp(n: number): Emp {
    return this.emps[n - 1];
  }

  private backfillAudit(t0: number) {
    const at = (min: number) => iso(t0 - min * 60_000);
    const add = (min: number, kind: AuditKind, n: number, summary: string, severity: number, actor = "system", ref: string | null = null) => {
      const e = this.emp(n);
      this.log.push({
        id: this.id(),
        t: at(min),
        kind,
        device_id: e.device_id,
        user_id: e.user_id,
        handle: e.handle,
        actor,
        summary,
        severity,
        ref_id: ref,
      });
    };

    // Employee 10: an earlier trust drop that a voice check cleared and an admin acknowledged.
    const e10 = this.emp(10);
    const dropDevs = [deviation("ms.v_p50", 2.2), deviation("kb.hold_p50", -1.8)];
    const drop: AnomalyLive = {
      id: this.id(),
      kind: "trust_drop",
      severity: 2,
      trust_before: 0.92,
      trust_after: 0.61,
      top_features: dropDevs,
      action: "none",
      challenge_id: null,
      explanation: "Pointer speed and key hold moved away from this employee's baseline; trust stayed above 40%, so no challenge.",
    };
    e10.anomaly = drop;
    e10.anomalyAt = at(34);
    const e12 = this.emp(12);
    const held: AnomalyLive = {
      id: this.id(),
      kind: "lock",
      severity: 4,
      trust_before: 0.93,
      trust_after: 0.93,
      top_features: [],
      action: "admin_lock",
      challenge_id: null,
      explanation: "Locked by an admin after a lost-device report; behavior was normal at the time.",
    };
    e12.anomaly = held;
    e12.anomalyAt = at(26);

    add(47, "model", 2, "Identity model v7 → v8 · +46 genuine blocks learned (safe-update loop)", 0);
    add(44, "marker", 9, "Session started · OS screen unlock → trust anchored at 80%", 0);
    add(41, "decision", 16, "Export → allow (Y) · co-present · 96%", 0);
    add(38, "trust_change", 5, "Watch → Normal · 83%", 1);
    add(34, "alert", 10, `Trust drop 92% → 61% · ${fmtDevs(dropDevs)} — above 40%, no challenge`, 3, "system", drop.id);
    add(33, "trust_change", 10, "Normal → Watch · 61%", 2);
    add(31, "challenge", 10, "Proactive voice check passed (VERIFY) → trust re-anchored at 97%", 1);
    add(30, "admin_action", 10, "Acknowledged alert: trust drop", 1, DEMO_ACTOR, drop.id);
    add(29, "model", 19, "Enrollment started · collecting a behavioral baseline (no model yet)", 0);
    add(27, "decision", 3, "Purchase $2,000 → Y (frictionless) · co-present · 97%", 0);
    add(26, "admin_action", 12, "Admin lock: owner reported the laptop missing — hold until IT review", 4, DEMO_ACTOR, held.id);
    add(26, "lock", 12, "Device locked (admin_lock) · trust pinned at 93%", 3);
    add(22, "model", 14, "Identity model v3 → v4 · +31 genuine blocks learned", 0);
    add(19, "decision", 15, "Add payee → step-up (C) · 72% is below the R2 floor", 2);
    add(18, "challenge", 15, "Voice check passed (VERIFY) → add payee allowed (Y)", 1);
    add(15, "admin_action", 8, "Note: “new keyboard issued today — expect keyboard drift”", 0, DEMO_ACTOR);
    add(12, "marker", 17, "Session started · OS screen unlock → trust anchored at 80%", 0);
    add(9, "model", 6, "Identity model v10 → v11 · +52 genuine blocks learned", 0);
    add(6, "alert", 4, "Remote session: a browser signed in as Employee 04 is not co-present with FIN-MBA15-04 → web actions use the 30% prior", 3);
    add(4, "decision", 6, "View → allow (Y) · co-present · 98%", 0);
    add(3, "trust_change", 11, "Watch → Normal · 84%", 1);
    add(1, "decision", 1, "Export → allow (Y) · co-present · 95%", 0);
    this.log.sort((a, b) => Date.parse(b.t) - Date.parse(a.t));
  }

  // ---- snapshots -----------------------------------------------------------

  roster(): RosterRow[] {
    return this.emps.map((e) => {
      const learning = e.mode === "enroll";
      const confidence = learning ? null : sigmoid(e.L);
      return {
        device_id: e.device_id,
        user_id: e.user_id,
        handle: e.handle,
        team: e.team,
        synthetic: true,
        device_label: e.device_label,
        online: e.online,
        last_seen: iso(e.lastSeen),
        mode: e.mode,
        level: rowLevel({ locked: e.locked, mode: e.mode, confidence }),
        confidence,
        display: confidence === null ? null : trustDisplay(confidence),
        locked: e.locked,
        lock_reason: e.lockReason,
        open_challenge: e.challenge ? { ...e.challenge.live } : null,
        model_version: e.modelVersion,
        model_backend: e.modelVersion ? "twobme_ml" : null,
        last_anomaly: e.anomaly ? { ...e.anomaly, top_features: e.anomaly.top_features.slice() } : null,
        last_anomaly_at: e.anomalyAt,
        sparkline: e.spark.slice(),
        flags: orderFlags(e.flags),
      };
    });
  }

  audit(): AuditRow[] {
    return this.log.slice();
  }

  // ---- events --------------------------------------------------------------

  private auditRow(e: Emp, now: number, kind: AuditKind, summary: string, severity: number, actor = "system", ref: string | null = null): AuditRow {
    const row: AuditRow = {
      id: this.id(),
      t: iso(now),
      kind,
      device_id: e.device_id,
      user_id: e.user_id,
      handle: e.handle,
      actor,
      summary,
      severity,
      ref_id: ref,
    };
    this.log = [row, ...this.log].slice(0, 500);
    return row;
  }

  private emitAudit(out: LiveEvent[], e: Emp, now: number, kind: AuditKind, summary: string, severity: number, actor = "system", ref: string | null = null): AuditRow {
    const row = this.auditRow(e, now, kind, summary, severity, actor, ref);
    out.push({ type: "audit", device_id: e.device_id, t: row.t, data: row });
    return row;
  }

  /**
   * A trust push. `reasons` given = a push the hub makes for a server-side action (hub._push_trust with [kind] right
   * before `lock`, or ["admin_unlock"] right after `unlock`); only agent ticks and in-session pushes prove presence.
   */
  private emitTrust(out: LiveEvent[], e: Emp, now: number, deltaL: number, reasons?: string[]) {
    const confidence = sigmoid(e.L);
    const data: TrustLive = {
      t: now / 1000,
      logit: e.L,
      delta_logit: deltaL,
      confidence,
      display: trustDisplay(confidence),
      level: rowLevel({ locked: e.locked, mode: e.mode, confidence }),
      per_modality: {},
      reasons: reasons ?? (e.compromised ? ["behavior_drift"] : []),
      seq: ++e.seq,
      locked: e.locked,
    };
    e.spark = [...e.spark, confidence].slice(-SPARK_MAX);
    if (!reasons?.some((r) => r === "admin_lock" || r === "admin_unlock")) {
      e.online = true;
      e.lastSeen = now;
    }
    out.push({ type: "trust", device_id: e.device_id, t: iso(now), data });
  }

  private emitChallenge(out: LiveEvent[], e: Emp, now: number) {
    if (!e.challenge) return;
    out.push({ type: "challenge", device_id: e.device_id, t: iso(now), data: { ...e.challenge.live } });
  }

  private emitAnomaly(out: LiveEvent[], e: Emp, now: number) {
    if (!e.anomaly) return;
    out.push({ type: "anomaly", device_id: e.device_id, t: iso(now), data: { ...e.anomaly, top_features: e.anomaly.top_features.slice() } });
  }

  private setFlag(e: Emp, flag: OrgFlag, on: boolean) {
    e.flags = setFlag(e.flags, flag, on);
  }

  private raiseAnomaly(e: Emp, now: number, kind: AnomalyKind, severity: number, before: number | null, after: number | null, devs: DeviationOut[], explanation: string): AnomalyLive {
    const a: AnomalyLive = {
      id: this.id(),
      kind,
      severity,
      trust_before: before,
      trust_after: after,
      top_features: devs,
      action: null,
      challenge_id: null,
      explanation,
    };
    e.anomaly = a;
    e.anomalyAt = iso(now);
    return a;
  }

  private issueChallenge(out: LiveEvent[], e: Emp, now: number, trigger: ChallengeTrigger, outcome: SimChallenge["outcome"], ttlS: number, decision: DecisionLive | null = null): SimChallenge {
    const c: SimChallenge = {
      live: { challenge_id: this.id(), trigger, status: "issued", attempt: 1, expires_at: iso(now + ttlS * 1000), verify_url: null },
      issued: this.stepCount,
      outcome,
      decision,
    };
    e.challenge = c;
    this.setFlag(e, "challenge_open", true);
    this.emitChallenge(out, e, now);
    return c;
  }

  private closeChallenge(e: Emp) {
    e.challenge = null;
    this.setFlag(e, "challenge_open", false);
  }

  // ---- the story -----------------------------------------------------------

  step(now: number): LiveEvent[] {
    const s = ++this.stepCount;
    const out: LiveEvent[] = [];
    for (const e of this.emps) this.script(out, e, s, now);
    for (const e of this.emps) if (e.challenge) this.progressChallenge(out, e, s, now);
    for (const e of this.emps) {
      if ((s + e.i) % TICK_EVERY !== 0 || !e.online || e.mode !== "monitor") continue;
      this.tick(out, e, now);
    }
    return out;
  }

  private script(out: LiveEvent[], e: Emp, s: number, now: number) {
    switch (e.plan.role) {
      case "takeover": {
        const cs = s % TAKEOVER_CYCLE;
        if (cs === TAKEOVER_START && !e.locked && !e.compromised && !e.challenge) e.compromised = true;
        if (cs === OWNER_RETURNS && e.locked && e.lockReason !== "admin_lock" && !e.challenge) {
          e.compromised = false; // the owner is back at the keyboard
          this.emitAudit(out, e, now, "challenge", "Owner started a voice unlock from the lock screen", 1);
          this.issueChallenge(out, e, now, "unlock", null, 120);
        }
        break;
      }
      case "remote": {
        const cs = s % REMOTE_CYCLE;
        if (cs === REMOTE_ATTEMPT && !e.challenge && !e.locked) {
          const decision: DecisionLive = {
            decision_id: this.id(),
            status: "pending",
            decision: "step_up",
            trans_status: "C",
            confidence: TRUST_CONFIG.anchors.remote,
            tier: "R3",
            binding: "remote",
            reasons: ["remote_session", "below_tier_floor"],
            challenge_id: null,
            verify_url: null,
            action: "purchase",
            amount_cents: 200_000,
          };
          const c = this.issueChallenge(out, e, now, "step_up", "EXPIRE", 70, decision);
          decision.challenge_id = c.live.challenge_id;
          out.push({ type: "decision", device_id: e.device_id, t: iso(now), data: { ...decision } });
          this.emitAudit(
            out,
            e,
            now,
            "decision",
            "Purchase $2,000 from a remote browser session → step-up (C) · not co-present, 30% prior",
            3,
            "system",
            decision.decision_id,
          );
        }
        break;
      }
      case "dip": {
        const cs = s % DIP_CYCLE;
        if (cs === 30) e.base = 0.66;
        if (cs === 46) e.base = e.plan.base;
        break;
      }
      case "late":
        if (s === LATE_SIGN_IN && !e.online) {
          e.online = true;
          e.L = logit(TRUST_CONFIG.anchors.screen_unlock);
          this.emitAudit(out, e, now, "marker", "Session started · OS screen unlock → trust anchored at 80%", 0);
          this.emitTrust(out, e, now, 0);
        }
        break;
      case "learning":
        if (s === ENROLL_DONE && e.mode === "enroll") {
          e.mode = "monitor";
          e.modelVersion = 1;
          e.L = logit(TRUST_CONFIG.anchors.model_activate);
          out.push({ type: "mode", device_id: e.device_id, t: iso(now), data: { mode: "monitor" } });
          const model: ModelInfo = {
            status: "ready",
            job_id: null,
            version: 1,
            trained_at: iso(now),
            n_blocks: { keyboard: 184, mouse: 142, scroll: 38 },
            enabled_modalities: [...ACTIVE_MODALITIES],
            metrics: {},
            headline_medians: {},
            learned_since_enroll: 0,
            parent_version: null,
            error: null,
            backend: "twobme_ml",
          };
          out.push({ type: "model", device_id: e.device_id, t: iso(now), data: model });
          this.emitAudit(out, e, now, "model", "Enrollment complete → identity model v1 trained on 364 blocks · monitoring at 97%", 1);
          this.emitTrust(out, e, now, 0);
        }
        break;
      default:
        break;
    }
  }

  private progressChallenge(out: LiveEvent[], e: Emp, s: number, now: number) {
    const c = e.challenge;
    if (!c) return;
    const age = s - c.issued;
    if (c.outcome === "EXPIRE") {
      if (age < STEP_UP_EXPIRES) return;
      c.live = { ...c.live, status: "expired" };
      this.emitChallenge(out, e, now);
      if (c.decision) {
        out.push({ type: "decision", device_id: e.device_id, t: iso(now), data: { ...c.decision, status: "final", decision: "block", trans_status: "N" } });
      }
      this.closeChallenge(e);
      this.emitAudit(out, e, now, "challenge", "Step-up expired unanswered → $2,000 order declined (N)", 3, "system", c.decision?.decision_id ?? null);
      return;
    }
    if (age === VOICE_STEPS.prompt_ended || age === VOICE_STEPS.scoring) {
      c.live = { ...c.live, status: age === VOICE_STEPS.prompt_ended ? "prompt_ended" : "scoring" };
      this.emitChallenge(out, e, now);
      return;
    }
    if (age < VOICE_STEPS.result) return;
    const outcome: VoiceDecision = c.outcome ?? (e.compromised ? "BLOCK_SPOOF" : "VERIFY");
    if (outcome === "VERIFY") {
      c.live = { ...c.live, status: "verified" };
      this.emitChallenge(out, e, now);
      this.closeChallenge(e);
      this.setFlag(e, "takeover_suspected", false);
      e.compromised = false;
      e.alarmed = false;
      e.below = 0;
      const before = e.L;
      e.L = logit(TRUST_CONFIG.anchors.verify);
      const wasLocked = e.locked && e.lockReason !== "admin_lock";
      if (wasLocked) {
        e.locked = false;
        e.lockReason = null;
        out.push({ type: "unlock", device_id: e.device_id, t: iso(now), data: {} });
      }
      const summary = wasLocked
        ? "Owner unlocked with a fresh voice phrase (VERIFY) → trust re-anchored at 97%"
        : e.plan.role === "insider"
          ? `Voice check passed (VERIFY): it is ${e.handle} — the behavior drift persists, keep under insider-threat review`
          : "Voice check passed (VERIFY) → trust re-anchored at 97%";
      this.emitAudit(out, e, now, "challenge", summary, 1, "system", c.live.challenge_id);
      if (!e.locked) this.emitTrust(out, e, now, e.L - before);
      return;
    }
    // BLOCK_SPOOF / BLOCK_IMPOSTOR: the device locks; only the owner's fresh VERIFY unlocks it (§5.4).
    const spoof = outcome === "BLOCK_SPOOF";
    c.live = { ...c.live, status: spoof ? "blocked_spoof" : "blocked_impostor" };
    this.emitChallenge(out, e, now);
    this.closeChallenge(e);
    const conf = sigmoid(e.L);
    this.raiseAnomaly(
      e,
      now,
      spoof ? "voice_spoof" : "voice_impostor",
      5,
      conf,
      conf,
      [],
      spoof
        ? "The spoken phrase was correct but the synthetic-voice detector flagged it as generated speech."
        : "The phrase was correct but the speaker did not match the enrolled voice.",
    );
    if (e.anomaly) e.anomaly.challenge_id = c.live.challenge_id;
    this.emitAnomaly(out, e, now);
    // Like the live audit log, every anomaly is one detection row (the rail and the open-alerts KPI read these).
    this.emitAudit(
      out,
      e,
      now,
      "alert",
      spoof ? "Synthetic voice on the voice check: the phrase was right, the voice was generated" : "Different speaker on the voice check: the voice didn't match the owner",
      5,
      "system",
      e.anomaly?.id ?? null,
    );
    e.locked = true;
    e.lockReason = spoof ? "voice_spoof" : "voice_impostor"; // the hub's own lock reasons (hub._blocked)
    this.setFlag(e, "admin_locked", false);
    // Hub order (hub._blocked): trust(locked, reasons=[kind]) first, then the lock event.
    this.emitTrust(out, e, now, 0, [e.lockReason]);
    out.push({ type: "lock", device_id: e.device_id, t: iso(now), data: { reason: e.lockReason } });
    this.emitAudit(
      out,
      e,
      now,
      "lock",
      spoof
        ? "Voice check failed: synthetic voice detected (BLOCK_SPOOF) → device locked"
        : "Voice check failed: different speaker (BLOCK_IMPOSTOR) → device locked",
      5,
      "system",
      e.anomaly?.id ?? null,
    );
  }

  private tick(out: LiveEvent[], e: Emp, now: number) {
    const prevDisplay = trustDisplay(sigmoid(e.L));
    const prevLevel = rowLevel({ locked: e.locked, mode: e.mode, confidence: prevDisplay / 100 });
    const before = e.L;
    if (!e.locked) {
      if (e.compromised) {
        e.L = Math.max(logit(0.05), e.L - (0.75 + 0.12 * this.gauss()));
      } else {
        if (e.plan.role === "insider") e.base = Math.max(INSIDER_FLOOR, e.base - INSIDER_SLOPE);
        const noise = e.plan.role === "insider" ? 0.04 : 0.1;
        e.L = e.L + 0.35 * (logit(e.base) - e.L) + noise * this.gauss();
      }
      e.L = clampL(e.L);
    }
    this.emitTrust(out, e, now, e.L - before);
    if (e.locked) return;

    const conf = sigmoid(e.L);
    const display = trustDisplay(conf);
    const level = rowLevel({ locked: false, mode: e.mode, confidence: conf });
    if (level !== prevLevel) {
      const sev = level === "normal" ? 1 : 2;
      this.emitAudit(out, e, now, "trust_change", `${levelLabel(prevLevel)} → ${levelLabel(level)} · ${display}%`, sev);
    }

    // Insider drift: sustained, slow deviation into Watch with no takeover signature.
    if (e.plan.role === "insider" && level === "watch" && !e.flags.includes("insider_drift")) {
      this.setFlag(e, "insider_drift", true);
      const devs = INSIDER_SIGNATURE.map(([n, z]) => deviation(n, z + (this.rng() - 0.5) * 0.3));
      this.raiseAnomaly(
        e,
        now,
        "trust_drop",
        3,
        0.93,
        conf,
        devs,
        "Slow, sustained drift over 25 minutes in typing and pointer rhythm (more pauses, more hesitation before clicks) rather than a sudden change of hands: the insider-threat pattern.",
      );
      this.emitAnomaly(out, e, now);
      this.emitAudit(out, e, now, "alert", `Insider drift: 25 min of sustained deviation · ${fmtDevs(devs)} — no takeover signature, review activity`, 3, "system", e.anomaly?.id ?? null);
    }

    // Takeover arming (§5.4): below 0.40 for 2 consecutive ticks arms a proactive voice check.
    const { threshold, consecutive_ticks, rearm_above } = TRUST_CONFIG.arming;
    e.below = conf < threshold ? e.below + 1 : 0;
    if (conf >= rearm_above) e.alarmed = false;
    if (e.below >= 1 && !e.alarmed) {
      e.alarmed = true;
      const peak = Math.max(...e.spark.slice(-14));
      const devs = TAKEOVER_SIGNATURE.map(([n, z]) => deviation(n, z + (this.rng() - 0.5) * 0.4));
      const a = this.raiseAnomaly(
        e,
        now,
        "takeover_suspected",
        4,
        peak,
        conf,
        devs,
        "Keystroke flight time and pointer path curvature left this employee's baseline within 30 s: the signature of a change of hands.",
      );
      this.setFlag(e, "takeover_suspected", true);
      this.emitAnomaly(out, e, now);
      this.emitAudit(out, e, now, "alert", `Takeover suspected: ${trustDisplay(peak)}% → ${display}% · ${fmtDevs(devs)}`, 4, "system", a.id);
    }
    if (e.below >= consecutive_ticks && !e.challenge) {
      const c = this.issueChallenge(out, e, now, "proactive", null, TRUST_CONFIG.arming.proactive_expiry_s);
      if (e.anomaly && e.anomaly.kind === "takeover_suspected" && !e.anomaly.challenge_id) {
        e.anomaly.action = "challenge_issued";
        e.anomaly.challenge_id = c.live.challenge_id;
        this.emitAnomaly(out, e, now);
      }
      this.emitAudit(out, e, now, "challenge", `Proactive voice check issued · trust under 40% for ${consecutive_ticks} ticks`, 3, "system", c.live.challenge_id);
    }
  }

  // ---- admin actions -------------------------------------------------------

  act(input: AdminActionIn, now: number, actor: string): { row: AuditRow; events: LiveEvent[] } {
    const e = this.emps.find((x) => x.device_id === input.device_id);
    if (!e) throw new Error("Unknown device");
    const out: LiveEvent[] = [];
    let row: AuditRow;
    switch (input.action) {
      case "lock": {
        if (e.locked) throw new Error(`${e.handle} is already locked`);
        if (e.challenge) {
          e.challenge.live = { ...e.challenge.live, status: "cancelled" };
          this.emitChallenge(out, e, now);
          this.closeChallenge(e);
        }
        e.locked = true;
        e.lockReason = "admin_lock";
        this.setFlag(e, "admin_locked", true);
        // Hub order (routers/admin.py admin_lock): trust(locked, reasons=["admin_lock"]) first, then the lock event.
        this.emitTrust(out, e, now, 0, ["admin_lock"]);
        out.push({ type: "lock", device_id: e.device_id, t: iso(now), data: { reason: "admin_lock" } });
        row = this.emitAudit(out, e, now, "admin_action", "Admin lock: device locked pending review (trust pinned)", 4, actor);
        break;
      }
      case "unlock": {
        if (!e.locked) throw new Error(`${e.handle} is not locked`);
        if (e.lockReason !== "admin_lock") throw new Error("Voice-locked devices unlock only with the owner's fresh voice VERIFY");
        e.locked = false;
        e.lockReason = null;
        this.setFlag(e, "admin_locked", false);
        out.push({ type: "unlock", device_id: e.device_id, t: iso(now), data: {} });
        this.emitTrust(out, e, now, 0, ["admin_unlock"]); // hub order: unlock, then trust(["admin_unlock"])
        row = this.emitAudit(out, e, now, "admin_action", "Cleared the admin lock", 1, actor);
        break;
      }
      case "force_reverify": {
        if (e.locked) throw new Error(`${e.handle} is locked`);
        if (e.challenge) throw new Error(`${e.handle} already has an open challenge`);
        if (!e.online) throw new Error(`${e.handle} is offline`);
        row = this.emitAudit(out, e, now, "admin_action", "Forced a voice re-verification", 2, actor);
        this.issueChallenge(out, e, now, "proactive", null, TRUST_CONFIG.arming.proactive_expiry_s);
        break;
      }
      case "ack_alert": {
        const ref = input.anomaly_id ?? e.anomaly?.id ?? null;
        if (!ref) throw new Error(`${e.handle} has no alert to acknowledge`);
        const kind = e.anomaly && e.anomaly.id === ref ? e.anomaly.kind.replace(/_/g, " ") : "alert";
        row = this.emitAudit(out, e, now, "admin_action", `Acknowledged alert: ${kind}`, 1, actor, ref);
        break;
      }
      case "note": {
        const text = (input.text ?? "").trim().slice(0, 80);
        if (!text) throw new Error("A note needs text");
        row = this.emitAudit(out, e, now, "admin_action", `Note: “${text}”`, 0, actor);
        break;
      }
      default:
        throw new Error("Unknown action");
    }
    return { row, events: out };
  }
}

