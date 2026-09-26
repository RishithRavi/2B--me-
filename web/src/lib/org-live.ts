// Admin/org panel data layer (§2.4): one reducer for the live org stream and the synthetic demo org.
//
// Live: GET /api/admin/roster + /api/admin/audit, then /ws/live?scope=org (admin only, every device's events plus
// `audit` rows, no snapshot on open), a roster re-sync every 30 s and after every reconnect.
// Demo (?mock=1): lib/admin-mock.ts runs a seeded simulation that emits the SAME RosterRow / AuditRow / LiveEvent
// shapes, and its events go through the same applyOrg reducer.
//
// Display and level are always derived together from confidence (trustDisplay + rowLevel), so a row can never
// read "40% SUSPICIOUS": the level is the band of the percentage the admin actually sees.
import { useSyncExternalStore } from "react";

import { api, errorMessage, ApiError } from "./api";
import type {
  AdminActionIn,
  AuditKind,
  AuditRow,
  ChallengeStatus,
  Level,
  LiveEvent,
  LiveType,
  RosterRow,
  TrustLive,
} from "./contracts";
import { levelFromConfidence } from "./ui";

// ---------------------------------------------------------------------------
// Row semantics shared with the simulation
// ---------------------------------------------------------------------------

/** Last ≤ 60 tick confidences (5 min at 5 s ticks), matching RosterRow.sparkline on the server. */
export const SPARK_MAX = 60;
export const AUDIT_MAX = 500;
export const ROSTER_SYNC_MS = 30_000;

export type OrgFlag = "takeover_suspected" | "insider_drift" | "remote_session" | "admin_locked" | "challenge_open";

/** Canonical flag order (most urgent first); unknown server flags are kept after these. */
export const FLAG_ORDER: readonly OrgFlag[] = [
  "takeover_suspected",
  "insider_drift",
  "remote_session",
  "admin_locked",
  "challenge_open",
];

const FLAG_LABEL: Record<OrgFlag, string> = {
  takeover_suspected: "Takeover suspected",
  insider_drift: "Insider drift",
  remote_session: "Remote session",
  admin_locked: "Admin locked",
  challenge_open: "Challenge open",
};

export function flagLabel(flag: string): string {
  return FLAG_LABEL[flag as OrgFlag] ?? flag.replace(/_/g, " ");
}

/** display = min(99, round(100·conf)) — the engine's own rule (§5.4). */
export function trustDisplay(confidence: number): number {
  return Math.min(99, Math.max(0, Math.round(confidence * 100)));
}

/** Level for a roster row, banded on the DISPLAYED percentage so number and color always agree. */
export function rowLevel(r: { locked: boolean; mode?: string | null; confidence: number | null; level?: Level | null }): Level {
  if (r.locked) return "locked";
  if (r.mode === "enroll" || r.level === "learning" || r.confidence === null || !Number.isFinite(r.confidence)) return "learning";
  return levelFromConfidence(trustDisplay(r.confidence) / 100);
}

/** Server rows may carry a level computed from raw confidence; re-derive display + level consistently. */
export function normalizeRow(row: RosterRow): RosterRow {
  const confidence = row.confidence !== null && Number.isFinite(row.confidence) ? row.confidence : null;
  const display = confidence === null ? null : trustDisplay(confidence);
  const level = rowLevel({ locked: row.locked, mode: row.mode, confidence, level: row.level });
  const sparkline = (row.sparkline ?? []).slice(-SPARK_MAX);
  const flags = orderFlags(row.flags ?? []);
  if (display === row.display && level === row.level && sparkline.length === (row.sparkline ?? []).length && sameList(flags, row.flags ?? [])) {
    return row;
  }
  return { ...row, confidence, display, level, sparkline, flags };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function orderFlags(flags: readonly string[]): string[] {
  const known = FLAG_ORDER.filter((f) => flags.includes(f));
  const rest = flags.filter((f) => !(FLAG_ORDER as readonly string[]).includes(f));
  return [...known, ...Array.from(new Set(rest))];
}

export function setFlag(flags: readonly string[], flag: OrgFlag, on: boolean): string[] {
  const has = flags.includes(flag);
  if (has === on) return flags as string[];
  return orderFlags(on ? [...flags, flag] : flags.filter((f) => f !== flag));
}

const TERMINAL: ReadonlySet<ChallengeStatus> = new Set<ChallengeStatus>([
  "verified",
  "blocked_spoof",
  "blocked_impostor",
  "expired",
  "cancelled",
]);

export function isTerminal(status: ChallengeStatus): boolean {
  return TERMINAL.has(status);
}

/** TrustState.t is epoch seconds of the tick end; fall back to the envelope time. */
function trustTime(data: TrustLive, envT: string): string {
  if (Number.isFinite(data.t) && data.t > 1e9) return new Date(data.t * 1000).toISOString();
  return envT;
}

const tms = (iso: string | null | undefined): number => {
  if (!iso) return 0;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : 0;
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface OrgState {
  /** server order (A's real device first, then by severity); the view re-sorts for display */
  rows: RosterRow[];
  /** newest first, deduped by id, ≤ AUDIT_MAX */
  audit: AuditRow[];
  /** the first roster load finished (successfully or not) */
  loaded: boolean;
  /** last load / stream error (null when healthy) */
  error: string | null;
  /** HTTP status of the last failed load (0 = offline, 401/403 = not admin, 404 = endpoints not deployed) */
  errorStatus: number | null;
  connected: boolean;
  closeCode: number | null;
  /** client ms of the last applied event */
  lastEventAt: number | null;
  /** client ms of the last successful roster load */
  lastSyncAt: number | null;
  /** an event named a device the roster doesn't know yet → re-sync soon */
  stale: boolean;
}

export function initialOrgState(): OrgState {
  return {
    rows: [],
    audit: [],
    loaded: false,
    error: null,
    errorStatus: null,
    connected: false,
    closeCode: null,
    lastEventAt: null,
    lastSyncAt: null,
    stale: false,
  };
}

/** Newest first, deduped by id (incoming wins). Rows with the same timestamp keep arrival order: newer arrivals first. */
export function mergeAudit(existing: readonly AuditRow[], incoming: readonly AuditRow[]): AuditRow[] {
  if (incoming.length === 0) return existing as AuditRow[];
  const byId = new Map<string, AuditRow>();
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values(), ...existing.filter((r) => !byId.has(r.id))]
    .sort((a, b) => tms(b.t) - tms(a.t)) // stable
    .slice(0, AUDIT_MAX);
}

/** Replace the roster with a fresh server copy (every row normalized). */
export function mergeRoster(prev: OrgState, rows: readonly RosterRow[], at: number = Date.now()): OrgState {
  return { ...prev, rows: rows.map(normalizeRow), loaded: true, error: null, errorStatus: null, lastSyncAt: at, stale: false };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function patchRow(prev: OrgState, deviceId: string | null, receivedAt: number, fn: (row: RosterRow) => RosterRow): OrgState {
  if (!deviceId) return prev;
  const i = prev.rows.findIndex((r) => r.device_id === deviceId);
  if (i < 0) return { ...prev, stale: true, lastEventAt: receivedAt };
  const row = prev.rows[i];
  const next = fn(row);
  if (next === row) return { ...prev, lastEventAt: receivedAt };
  const rows = prev.rows.slice();
  rows[i] = next;
  return { ...prev, rows, lastEventAt: receivedAt };
}

/**
 * Pure reducer for org-scope /ws/live events. Only the fields an event actually carries change; flags that no
 * event can express (insider_drift is a server-side heuristic) are left to the roster re-sync.
 */
export function applyOrg(prev: OrgState, ev: LiveEvent, receivedAt: number = Date.now()): OrgState {
  switch (ev.type) {
    case "trust": {
      const d = ev.data;
      return patchRow(prev, ev.device_id, receivedAt, (row) => {
        const confidence = d.confidence;
        const locked = Boolean(d.locked);
        const flags = locked ? row.flags : setFlag(row.flags, "admin_locked", false);
        return {
          ...row,
          online: true,
          last_seen: trustTime(d, ev.t),
          confidence,
          display: trustDisplay(confidence),
          locked,
          lock_reason: locked ? row.lock_reason : null,
          level: rowLevel({ locked, mode: row.mode, confidence, level: d.level }),
          sparkline: [...row.sparkline, confidence].slice(-SPARK_MAX),
          flags,
        };
      });
    }

    case "anomaly": {
      const a = ev.data;
      return patchRow(prev, ev.device_id, receivedAt, (row) => {
        const same = row.last_anomaly?.id === a.id;
        const flags = a.kind === "takeover_suspected" ? setFlag(row.flags, "takeover_suspected", true) : row.flags;
        return { ...row, last_anomaly: a, last_anomaly_at: same ? row.last_anomaly_at : ev.t, flags };
      });
    }

    case "challenge": {
      const c = ev.data;
      return patchRow(prev, ev.device_id, receivedAt, (row) => {
        if (isTerminal(c.status)) {
          const open = row.open_challenge && row.open_challenge.challenge_id !== c.challenge_id ? row.open_challenge : null;
          let flags = setFlag(row.flags, "challenge_open", open !== null);
          // A fresh VERIFY re-anchors identity (§5.4): the takeover suspicion is resolved.
          if (c.status === "verified") flags = setFlag(flags, "takeover_suspected", false);
          return { ...row, open_challenge: open, flags };
        }
        return { ...row, open_challenge: c, flags: setFlag(row.flags, "challenge_open", true) };
      });
    }

    case "lock":
      return patchRow(prev, ev.device_id, receivedAt, (row) => ({
        ...row,
        locked: true,
        lock_reason: ev.data.reason,
        level: "locked",
        flags: setFlag(row.flags, "admin_locked", ev.data.reason === "admin_lock"),
      }));

    case "unlock":
      return patchRow(prev, ev.device_id, receivedAt, (row) => ({
        ...row,
        locked: false,
        lock_reason: null,
        level: rowLevel({ locked: false, mode: row.mode, confidence: row.confidence }),
        flags: setFlag(row.flags, "admin_locked", false),
      }));

    case "mode":
      return patchRow(prev, ev.device_id, receivedAt, (row) => {
        const mode = ev.data.mode;
        return { ...row, mode, level: rowLevel({ locked: row.locked, mode, confidence: row.confidence }) };
      });

    case "model":
      return patchRow(prev, ev.device_id, receivedAt, (row) =>
        ev.data.status === "ready" ? { ...row, model_version: ev.data.version, model_backend: ev.data.backend ?? row.model_backend } : row,
      );

    case "decision":
      return patchRow(prev, ev.device_id, receivedAt, (row) =>
        ev.data.binding === "remote" ? { ...row, flags: setFlag(row.flags, "remote_session", true) } : row,
      );

    case "presence":
      return patchRow(prev, ev.device_id, receivedAt, (row) => ({
        ...row,
        flags: setFlag(row.flags, "remote_session", ev.data.binding === "remote"),
      }));

    case "label":
      // Demo ground truth (who is really at the keyboard) is never shown to the admin as a detection.
      return { ...prev, lastEventAt: receivedAt };

    case "audit":
      return { ...prev, audit: mergeAudit(prev.audit, [ev.data]), lastEventAt: receivedAt };

    default:
      return prev;
  }
}

export function withOrgConnection(s: OrgState, connected: boolean, closeCode: number | null = s.closeCode): OrgState {
  if (s.connected === connected && s.closeCode === closeCode) return s;
  return { ...s, connected, closeCode };
}

// ---------------------------------------------------------------------------
// Derived views (pure; unit-tested)
// ---------------------------------------------------------------------------

/** 0 = most urgent. Offline rows sink below everything that is live. */
export function severityRank(row: RosterRow): number {
  if (row.locked) return 0;
  if (!row.online) return 7;
  if (row.level === "suspicious") return 1;
  if (row.flags.includes("takeover_suspected") || row.open_challenge) return 2;
  if (row.level === "watch") return 3;
  if (row.flags.length > 0) return 4;
  if (row.level === "learning") return 6;
  return 5;
}

export type RosterSort = "risk" | "name";

export function sortRoster(rows: readonly RosterRow[], by: RosterSort = "risk"): RosterRow[] {
  const byName = (a: RosterRow, b: RosterRow) => a.handle.localeCompare(b.handle, undefined, { numeric: true });
  return rows.slice().sort((a, b) => {
    // A's real device (non-synthetic) always leads, like the server's order.
    if (a.synthetic !== b.synthetic) return a.synthetic ? 1 : -1;
    if (by === "risk") {
      const d = severityRank(a) - severityRank(b);
      if (d) return d;
      const ca = a.confidence ?? 1;
      const cb = b.confidence ?? 1;
      if (ca !== cb) return ca - cb;
    }
    return byName(a, b);
  });
}

export const ALERT_SEVERITY = 3;

/** Alerts rail: every audit row at severity ≥ 3 (alert, high, lock), newest first. */
export function alertRows(audit: readonly AuditRow[], limit = 40): AuditRow[] {
  return audit.filter((r) => r.severity >= ALERT_SEVERITY).slice(0, limit);
}

/** Anomaly ids an admin has acknowledged (an admin_action audit row whose ref_id is that anomaly). */
export function ackedRefs(audit: readonly AuditRow[]): Map<string, AuditRow> {
  const out = new Map<string, AuditRow>();
  for (const r of audit) {
    if (r.kind === "admin_action" && r.ref_id && /acknowledg|\back(_alert)?\b/i.test(r.summary) && !out.has(r.ref_id)) out.set(r.ref_id, r);
  }
  return out;
}

export interface OrgKpis {
  total: number;
  online: number;
  atRisk: number;
  suspicious: number;
  watch: number;
  locked: number;
  openChallenges: number;
  alertsLastHour: number;
  synthetic: number;
}

export function orgKpis(rows: readonly RosterRow[], audit: readonly AuditRow[], now: number = Date.now()): OrgKpis {
  const hourAgo = now - 60 * 60 * 1000;
  let online = 0;
  let suspicious = 0;
  let watch = 0;
  let locked = 0;
  let openChallenges = 0;
  let synthetic = 0;
  for (const r of rows) {
    if (r.online) online++;
    if (r.synthetic) synthetic++;
    if (r.locked) locked++;
    else if (r.level === "suspicious") suspicious++;
    else if (r.level === "watch") watch++;
    if (r.open_challenge) openChallenges++;
  }
  const alertsLastHour = audit.filter((a) => a.severity >= ALERT_SEVERITY && tms(a.t) >= hourAgo).length;
  return { total: rows.length, online, atRisk: suspicious + watch, suspicious, watch, locked, openChallenges, alertsLastHour, synthetic };
}

export interface LevelDrop {
  row: RosterRow;
  from: Level;
  to: Level;
}

/**
 * Rows that just fell to suspicious or got locked, given the previous level per device. `prev` null (first load)
 * never reports a drop: toasts are for changes the admin watches happen, not for the state on arrival.
 */
export function levelDrops(prev: ReadonlyMap<string, Level> | null, rows: readonly RosterRow[]): LevelDrop[] {
  if (!prev) return [];
  const out: LevelDrop[] = [];
  for (const r of rows) {
    const from = prev.get(r.device_id);
    if (!from || from === r.level) continue;
    // Newly suspicious or newly locked; an unlock that lands in suspicious is not a new drop.
    const bad = r.level === "suspicious" || r.level === "locked";
    if (bad && from !== "locked") out.push({ row: r, from, to: r.level });
  }
  return out;
}

export const AUDIT_KINDS: readonly AuditKind[] = [
  "alert",
  "trust_change",
  "challenge",
  "decision",
  "lock",
  "admin_action",
  "marker",
  "model",
];

export function auditKindLabel(kind: AuditKind | string): string {
  switch (kind) {
    case "trust_change":
      return "Trust change";
    case "alert":
      return "Alert";
    case "challenge":
      return "Challenge";
    case "decision":
      return "Decision";
    case "lock":
      return "Lock";
    case "admin_action":
      return "Admin action";
    case "marker":
      return "Session";
    case "model":
      return "Model";
    default:
      return String(kind);
  }
}

/** CSV for the breach trace-back export (the filtered audit rows, oldest first). */
export function auditCsv(rows: readonly AuditRow[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["time", "employee", "device_id", "kind", "actor", "severity", "summary", "ref_id"];
  const lines = rows
    .slice()
    .reverse()
    .map((r) => [r.t, r.handle, r.device_id, r.kind, r.actor, r.severity, r.summary, r.ref_id].map(esc).join(","));
  return [header.join(","), ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// Parsing + URL
// ---------------------------------------------------------------------------

const ORG_TYPES: ReadonlySet<LiveType> = new Set<LiveType>([
  "trust", "anomaly", "challenge", "lock", "unlock", "mode", "model", "decision", "presence", "label", "audit",
]);

/** Parse one org-scope frame; types the admin panel doesn't use (block_scored, health, …) are dropped. */
export function parseOrgEvent(raw: string): LiveEvent | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    const o = v as { type?: unknown; data?: unknown; t?: unknown; device_id?: unknown };
    if (typeof o.type !== "string" || !ORG_TYPES.has(o.type as LiveType)) return null;
    if (!o.data || typeof o.data !== "object") return null;
    return {
      ...(o as object),
      t: typeof o.t === "string" ? o.t : new Date().toISOString(),
      device_id: typeof o.device_id === "string" ? o.device_id : null,
    } as LiveEvent;
  } catch {
    return null;
  }
}

/** Same origin rules as lib/live.ts (NEXT_PUBLIC_WS_ORIGIN in dev, else this page's host). */
export function orgLiveUrl(): string {
  const origin =
    process.env.NEXT_PUBLIC_WS_ORIGIN ??
    (typeof window !== "undefined" ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}` : "");
  return `${origin}/ws/live?scope=org`;
}

// ---------------------------------------------------------------------------
// Store (one per page; shared by every admin component through useSyncExternalStore)
// ---------------------------------------------------------------------------

type Listener = () => void;

const BACKOFF_MIN = 500;
const BACKOFF_MAX = 10_000;
const STALE_SYNC_MIN_MS = 5_000;
export const DEMO_ACTOR = "demo admin";

/** Minimal surface of the simulation the store drives (lib/admin-mock.ts implements it). */
export interface OrgSimLike {
  roster(): RosterRow[];
  audit(): AuditRow[];
  step(now: number): LiveEvent[];
  act(input: AdminActionIn, now: number, actor: string): { row: AuditRow; events: LiveEvent[] };
  readonly stepMs: number;
}

export class OrgStore {
  private state: OrgState = initialOrgState();
  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private sim: OrgSimLike | null = null;
  private backoff = BACKOFF_MIN;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stepTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private lastStaleSync = 0;
  private running = false;
  private generation = 0;

  constructor(readonly kind: "live" | "mock") {}

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (!this.running) this.start();
    return () => {
      this.listeners.delete(l);
      if (this.listeners.size === 0 && !this.stopTimer) {
        // Grace period: survives StrictMode double-mount and quick navigation.
        this.stopTimer = setTimeout(() => {
          this.stopTimer = null;
          if (this.listeners.size === 0) this.stop();
        }, 1500);
      }
    };
  };

  getSnapshot = (): OrgState => this.state;

  private set(next: OrgState) {
    if (next === this.state) return;
    this.state = next;
    for (const l of this.listeners) l();
    if (next.stale && this.kind === "live") this.syncSoon();
  }

  dispatch = (ev: LiveEvent) => {
    this.set(applyOrg(this.state, ev));
  };

  private start() {
    this.running = true;
    const gen = ++this.generation;
    if (this.kind === "mock") {
      // The simulation is loaded on demand so live admins never download it.
      void import("./admin-mock").then(({ createOrgSim }) => {
        if (!this.running || gen !== this.generation) return;
        const sim = createOrgSim({ now: Date.now() });
        this.sim = sim;
        this.set({
          ...mergeRoster(initialOrgState(), sim.roster()),
          audit: mergeAudit([], sim.audit()),
          connected: true,
        });
        this.stepTimer = setInterval(() => this.mockStep(), sim.stepMs);
      });
      return;
    }
    void this.sync(true);
    this.connect();
    this.pollTimer = setInterval(() => void this.sync(false), ROSTER_SYNC_MS);
  }

  private stop() {
    this.running = false;
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.stepTimer) clearInterval(this.stepTimer);
    this.retryTimer = null;
    this.pollTimer = null;
    this.stepTimer = null;
    this.sim = null;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null;
      ws.close();
    }
    this.set(withOrgConnection(this.state, false));
  }

  private mockStep() {
    const sim = this.sim;
    if (!sim) return;
    const now = Date.now();
    let s = this.state;
    for (const ev of sim.step(now)) s = applyOrg(s, ev, now);
    // The simulation is the "server": reconcile server-only flags (insider_drift) exactly like the live re-sync.
    this.set({ ...mergeRoster(s, sim.roster(), now), audit: s.audit, connected: true });
  }

  /** Load the roster (and the audit trail on first load / reconnect). */
  async sync(withAudit: boolean): Promise<void> {
    if (this.kind === "mock") {
      if (this.sim) this.set(mergeRoster(this.state, this.sim.roster()));
      return;
    }
    if (this.syncing) return;
    this.syncing = true;
    const gen = this.generation;
    try {
      const [rows, audit] = await Promise.all([api.adminRoster(), withAudit ? api.adminAudit(200) : Promise.resolve(null)]);
      if (gen !== this.generation) return;
      let next = mergeRoster(this.state, rows);
      if (audit) next = { ...next, audit: mergeAudit(next.audit, audit) };
      this.set(next);
    } catch (e) {
      if (gen !== this.generation) return;
      const status = e instanceof ApiError ? e.status : 0;
      this.set({ ...this.state, loaded: true, error: errorMessage(e), errorStatus: status });
    } finally {
      this.syncing = false;
    }
  }

  private syncSoon() {
    const now = Date.now();
    if (now - this.lastStaleSync < STALE_SYNC_MIN_MS) return;
    this.lastStaleSync = now;
    void this.sync(false);
  }

  private connect() {
    if (typeof window === "undefined" || !this.running) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(orgLiveUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const wasReconnect = this.backoff > BACKOFF_MIN || this.state.closeCode !== null;
      this.backoff = BACKOFF_MIN;
      this.set(withOrgConnection(this.state, true, null));
      // No snapshot on open for scope=org: fill any gap from REST.
      if (wasReconnect) void this.sync(true);
    };
    ws.onmessage = (msg: MessageEvent) => {
      if (typeof msg.data !== "string") return;
      const ev = parseOrgEvent(msg.data);
      if (ev) this.dispatch(ev);
    };
    ws.onclose = (e: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.set(withOrgConnection(this.state, false, e.code));
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect() {
    if (!this.running || this.retryTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(BACKOFF_MAX, this.backoff * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Run an admin action. Live: POST /api/admin/actions (the hub's own events follow on the socket). Demo: the
   * simulation applies it and emits the same events, so the affordances behave identically.
   */
  async act(input: AdminActionIn): Promise<AuditRow> {
    if (this.kind === "mock") {
      const sim = this.sim;
      if (!sim) throw new Error("The demo org is still starting");
      const now = Date.now();
      const { row, events } = sim.act(input, now, DEMO_ACTOR);
      let s = this.state;
      for (const ev of events) s = applyOrg(s, ev, now);
      this.set({ ...mergeRoster(s, sim.roster(), now), audit: mergeAudit(s.audit, [row]), connected: true });
      return row;
    }
    const row = await api.adminAction(input);
    this.set({ ...this.state, audit: mergeAudit(this.state.audit, [row]) });
    return row;
  }
}

let liveStore: OrgStore | null = null;
let mockStore: OrgStore | null = null;

export function getOrgStore(mock: boolean): OrgStore {
  if (mock) return (mockStore ??= new OrgStore("mock"));
  return (liveStore ??= new OrgStore("live"));
}

const INITIAL = initialOrgState();
const idleSubscribe = () => () => {};
const idleSnapshot = () => INITIAL;

export interface UseOrgLiveOptions {
  /** true = the seeded synthetic org (demo); false = the admin API + org socket */
  mock: boolean;
  /** false = don't load or connect (e.g. while auth is still settling) */
  enabled?: boolean;
}

export function useOrgLive(opts: UseOrgLiveOptions): { state: OrgState; store: OrgStore | null; mock: boolean } {
  const enabled = opts.enabled ?? true;
  const store = enabled ? getOrgStore(opts.mock) : null;
  const state = useSyncExternalStore(store ? store.subscribe : idleSubscribe, store ? store.getSnapshot : idleSnapshot, idleSnapshot);
  return { state, store, mock: opts.mock };
}
