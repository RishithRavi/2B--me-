// /ws/live client: a pure reducer (applyLive) + one shared WebSocket per page (module singleton)
// + a React hook (useLive). Mock mode swaps the socket for an in-browser synthetic stream (live-mock.ts).
import { useSyncExternalStore } from "react";

import type {
  Actor,
  AnomalyLive,
  BlockScored,
  ChallengeLive,
  ChallengeStatus,
  ContextLive,
  DecisionLive,
  EnrollProgress,
  FeedItem,
  HealthLive,
  Label,
  LiveDevice,
  LiveEvent,
  LiveType,
  MarkerPoint,
  Modality,
  ModelInfo,
  PresenceLive,
  TrustLive,
  TrustPoint,
  VoiceResultLive,
  VoiceStageLive,
} from "./contracts";
import { MockLive, type MockControls } from "./live-mock";
import { useMockMode } from "./mode";
import { levelFromConfidence } from "./ui";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const WINDOW_MS = 10 * 60 * 1000;
export const FEED_MAX = 50;
const BLOCKS_MAX = 400;
const DECISIONS_MAX = 20;
const VOICE_RESULTS_MAX = 10;

export type LiveAnomaly = AnomalyLive & { t: string };
export type LiveDecision = DecisionLive & { t: string };
export type LiveVoiceResult = VoiceResultLive & { t: string };

export interface KnownDevice {
  id: string;
  label: string;
}

export interface LiveState {
  // ---- snapshot fields ----
  device: LiveDevice | null;
  session_id: string | null;
  label: Label;
  actor: Actor;
  trust: TrustLive | null;
  /** oldest first, last 10 min */
  trust_history: TrustPoint[];
  /** oldest first, last 10 min */
  markers: MarkerPoint[];
  model: ModelInfo | null;
  enroll: EnrollProgress | null;
  open_challenge: ChallengeLive | null;
  /** newest first, ≤ 50: snapshot recent_events + derived lines + `feed` events */
  recent: FeedItem[];
  last_tick_json: Record<string, unknown> | null;
  health: HealthLive | null;
  enrolled_psd: number[] | null;
  // ---- incremental ----
  lastBlocks: Partial<Record<Modality, BlockScored>>;
  /** oldest first, last 10 min (TTD block counts, why-chips) */
  blocks: BlockScored[];
  context: ContextLive | null;
  /** newest first; a re-sent id replaces in place */
  anomalies: LiveAnomaly[];
  /** newest first */
  decisions: LiveDecision[];
  /** per challenge id, one entry per stage (latest wins) */
  voiceStages: Record<string, VoiceStageLive[]>;
  /** newest first */
  voiceResults: LiveVoiceResult[];
  presence: PresenceLive | null;
  // ---- connection / bookkeeping ----
  connected: boolean;
  /** a snapshot arrived on the current connection (false while connecting, after a disconnect or a reconnect):
   *  until then the snapshot fields are left over from an earlier connection (maybe another account's) */
  synced: boolean;
  /** WS close code of the last disconnect (4401 = not signed in) */
  closeCode: number | null;
  /** device the stream is focused on (null = first snapshot decides) */
  focus: string | null;
  knownDevices: Record<string, KnownDevice>;
  /** client ms when `health` arrived (ages are extrapolated from it) */
  healthAt: number | null;
  /** client ms of the last event */
  lastEventAt: number | null;
}

export function initialLiveState(): LiveState {
  return {
    device: null,
    session_id: null,
    label: "genuine",
    actor: "a",
    trust: null,
    trust_history: [],
    markers: [],
    model: null,
    enroll: null,
    open_challenge: null,
    recent: [],
    last_tick_json: null,
    health: null,
    enrolled_psd: null,
    lastBlocks: {},
    blocks: [],
    context: null,
    anomalies: [],
    decisions: [],
    voiceStages: {},
    voiceResults: [],
    presence: null,
    connected: false,
    synced: false,
    closeCode: null,
    focus: null,
    knownDevices: {},
    healthAt: null,
    lastEventAt: null,
  };
}

// ---------------------------------------------------------------------------
// Reducer helpers
// ---------------------------------------------------------------------------

const tms = (iso: string): number => {
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : 0;
};

function trimByTime<T>(items: T[], getT: (x: T) => number, windowMs = WINDOW_MS): T[] {
  if (items.length === 0) return items;
  let latest = -Infinity;
  for (const x of items) latest = Math.max(latest, getT(x));
  const cutoff = latest - windowMs;
  return items.filter((x) => getT(x) >= cutoff);
}

/**
 * Markers keep the 10-minute window, plus the latest takeover_start and every marker after it until a Reset
 * follows: an open takeover (or its frozen time-to-detection) never loses its start marker to the window.
 */
export function trimMarkers(markers: MarkerPoint[]): MarkerPoint[] {
  if (markers.length === 0) return markers;
  let start = -Infinity;
  for (const m of markers) if (m.label === "takeover_start") start = Math.max(start, tms(m.t));
  const reset = markers.some((m) => m.label === "reset" && tms(m.t) > start);
  const keepFrom = Number.isFinite(start) && !reset ? start : Infinity;
  let latest = -Infinity;
  for (const m of markers) latest = Math.max(latest, tms(m.t));
  const cutoff = Math.min(latest - WINDOW_MS, keepFrom);
  return markers.filter((m) => tms(m.t) >= cutoff);
}

function pushFeed(recent: FeedItem[], item: FeedItem): FeedItem[] {
  return [item, ...recent].slice(0, FEED_MAX);
}

/** TrustState.t is epoch seconds of the tick end; fall back to the envelope time. */
function trustTime(data: TrustLive, envT: string): string {
  if (Number.isFinite(data.t) && data.t > 1e9) return new Date(data.t * 1000).toISOString();
  return envT;
}

const TERMINAL: ReadonlySet<ChallengeStatus> = new Set<ChallengeStatus>([
  "verified",
  "blocked_spoof",
  "blocked_impostor",
  "expired",
  "cancelled",
]);

const ANOMALY_LABEL: Record<AnomalyLive["kind"], string> = {
  trust_drop: "trust drop",
  takeover_suspected: "takeover suspected",
  voice_spoof: "synthetic voice",
  voice_impostor: "different speaker",
  lock: "device locked",
  redteam_tool: "red-team tool read",
};

export function anomalyLabel(kind: AnomalyLive["kind"]): string {
  return ANOMALY_LABEL[kind] ?? kind;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Pure reducer for /ws/live events. The event feed is server-authored only: `snapshot.recent_events`
 * plus `feed` events (the server emits a FeedItem for every notable thing), so nothing here derives lines.
 */
export function applyLive(prev: LiveState, ev: LiveEvent, receivedAt: number = Date.now()): LiveState {
  // Remember every device we hear about (admin sees all devices → device picker).
  let knownDevices = prev.knownDevices;
  if (ev.device_id && !knownDevices[ev.device_id]) {
    knownDevices = { ...knownDevices, [ev.device_id]: { id: ev.device_id, label: ev.device_id.slice(0, 8) } };
  }
  if (ev.type === "snapshot" && ev.data.device) {
    const d = ev.data.device;
    knownDevices = { ...knownDevices, [d.id]: { id: d.id, label: d.label } };
  }

  // Focus: once a device is chosen, events for other devices only update knownDevices.
  const evDevice = ev.type === "snapshot" ? (ev.data.device?.id ?? ev.device_id) : ev.device_id;
  if (prev.focus && evDevice && evDevice !== prev.focus) {
    return knownDevices === prev.knownDevices ? prev : { ...prev, knownDevices };
  }

  const s: LiveState = { ...prev, knownDevices, lastEventAt: receivedAt };

  switch (ev.type) {
    case "snapshot": {
      const d = ev.data;
      const fresh = initialLiveState();
      const recent = [...(d.recent_events ?? [])].sort((a, b) => tms(b.t) - tms(a.t)).slice(0, FEED_MAX);
      return {
        ...fresh,
        device: d.device,
        session_id: d.session_id,
        label: d.label,
        actor: d.actor,
        trust: d.trust,
        trust_history: trimByTime([...(d.trust_history ?? [])].sort((a, b) => tms(a.t) - tms(b.t)), (p) => tms(p.t)),
        markers: [...(d.markers ?? [])].sort((a, b) => tms(a.t) - tms(b.t)),
        model: d.model,
        enroll: d.enroll,
        open_challenge: d.open_challenge,
        recent,
        last_tick_json: d.last_tick_json,
        health: d.health,
        healthAt: d.health ? receivedAt : null,
        enrolled_psd: d.enrolled_psd,
        blocks: [...(d.recent_blocks ?? [])].sort((a, b) => tms(a.t_end) - tms(b.t_end)).slice(-BLOCKS_MAX),
        lastBlocks: Object.fromEntries((d.recent_blocks ?? []).map((b) => [b.modality, b])),
        connected: prev.connected,
        synced: true,
        closeCode: prev.closeCode,
        focus: prev.focus ?? d.device?.id ?? ev.device_id ?? null,
        knownDevices,
        lastEventAt: receivedAt,
      };
    }

    case "trust": {
      const d = ev.data;
      const t = trustTime(d, ev.t);
      const level = d.locked ? "locked" : d.level;
      const point: TrustPoint = { t, confidence: d.confidence, level };
      const history = trimByTime([...s.trust_history, point], (p) => tms(p.t));
      const markers = trimMarkers(s.markers);
      const device = s.device && s.device.locked !== d.locked ? { ...s.device, locked: d.locked } : s.device;
      return { ...s, trust: d, trust_history: history, markers, device };
    }

    case "block_scored": {
      const b = ev.data;
      const blocks = trimByTime([...s.blocks, b], (x) => tms(x.t_end)).slice(-BLOCKS_MAX);
      return { ...s, lastBlocks: { ...s.lastBlocks, [b.modality]: b }, blocks };
    }

    case "context":
      return { ...s, context: ev.data, enrolled_psd: ev.data.enrolled_psd ?? s.enrolled_psd };

    case "enroll_progress": {
      const device = s.device && s.device.mode !== ev.data.mode ? { ...s.device, mode: ev.data.mode } : s.device;
      return { ...s, enroll: ev.data, device };
    }

    case "model":
      return { ...s, model: ev.data };

    case "anomaly": {
      const a = ev.data;
      const idx = s.anomalies.findIndex((x) => x.id === a.id);
      if (idx >= 0) {
        const anomalies = s.anomalies.slice();
        anomalies[idx] = { ...a, t: s.anomalies[idx].t };
        return { ...s, anomalies };
      }
      return { ...s, anomalies: [{ ...a, t: ev.t }, ...s.anomalies].slice(0, FEED_MAX) };
    }

    case "challenge": {
      const c = ev.data;
      const prevC = s.open_challenge;
      let open_challenge: ChallengeLive | null = c;
      if (TERMINAL.has(c.status)) open_challenge = prevC && prevC.challenge_id !== c.challenge_id ? prevC : null;
      return { ...s, open_challenge };
    }

    case "voice_stage": {
      const v = ev.data;
      const list = (s.voiceStages[v.challenge_id] ?? []).filter((x) => x.stage !== v.stage);
      return { ...s, voiceStages: { ...s.voiceStages, [v.challenge_id]: [...list, v] } };
    }

    case "voice_result":
      return { ...s, voiceResults: [{ ...ev.data, t: ev.t }, ...s.voiceResults].slice(0, VOICE_RESULTS_MAX) };

    case "decision": {
      const d = ev.data;
      const idx = s.decisions.findIndex((x) => x.decision_id === d.decision_id);
      const entry: LiveDecision = { ...d, t: idx >= 0 ? s.decisions[idx].t : ev.t };
      const decisions = idx >= 0 ? s.decisions.map((x, i) => (i === idx ? entry : x)) : [entry, ...s.decisions].slice(0, DECISIONS_MAX);
      return { ...s, decisions };
    }

    case "marker": {
      const markers = trimMarkers([...s.markers, ev.data].sort((a, b) => tms(a.t) - tms(b.t)));
      return { ...s, markers };
    }

    case "mode": {
      const mode = ev.data.mode;
      const device = s.device ? { ...s.device, mode } : s.device;
      const enroll = s.enroll ? { ...s.enroll, mode } : s.enroll;
      return { ...s, device, enroll };
    }

    case "lock": {
      const device = s.device ? { ...s.device, locked: true, lock_reason: ev.data.reason } : s.device;
      const trust = s.trust ? { ...s.trust, locked: true, level: "locked" as const } : s.trust;
      return { ...s, device, trust };
    }

    case "unlock": {
      const device = s.device ? { ...s.device, locked: false, lock_reason: null } : s.device;
      // Drop the sticky "locked" level right away (the next trust tick carries the real one).
      const trust = s.trust
        ? { ...s.trust, locked: false, level: s.trust.level === "locked" ? levelFromConfidence(s.trust.confidence) : s.trust.level }
        : s.trust;
      return { ...s, device, trust };
    }

    case "label":
      return { ...s, label: ev.data.label, actor: ev.data.actor };

    case "presence":
      return { ...s, presence: ev.data };

    case "health":
      return {
        ...s,
        health: ev.data,
        healthAt: receivedAt,
        last_tick_json: ev.data.last_tick_json ?? s.last_tick_json,
      };

    case "feed":
      return { ...s, recent: pushFeed(s.recent, ev.data) };

    default:
      return s;
  }
}

export function withConnection(s: LiveState, connected: boolean, closeCode: number | null = s.closeCode): LiveState {
  if (s.connected === connected && s.closeCode === closeCode) return s;
  return { ...s, connected, closeCode, synced: s.synced && connected && s.connected };
}

// ---------------------------------------------------------------------------
// Parsing + URL
// ---------------------------------------------------------------------------

const LIVE_TYPES: ReadonlySet<LiveType> = new Set<LiveType>([
  "snapshot", "trust", "block_scored", "context", "enroll_progress", "model", "anomaly", "challenge",
  "voice_stage", "voice_result", "decision", "marker", "mode", "lock", "unlock", "label", "presence",
  "health", "feed", "audit",
]);

export function parseLive(raw: string): LiveEvent | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    const o = v as { type?: unknown; data?: unknown; t?: unknown; device_id?: unknown };
    if (typeof o.type !== "string" || !LIVE_TYPES.has(o.type as LiveType)) return null;
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

export function liveUrl(deviceId?: string | null): string {
  const origin =
    process.env.NEXT_PUBLIC_WS_ORIGIN ??
    (typeof window !== "undefined" ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}` : "");
  const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
  return `${origin}/ws/live${q}`;
}

// ---------------------------------------------------------------------------
// Store (one socket per page, shared by every component via useSyncExternalStore)
// ---------------------------------------------------------------------------

type Listener = () => void;

const BACKOFF_MIN = 500;
const BACKOFF_MAX = 10_000;

export class LiveStore {
  private state: LiveState = initialLiveState();
  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private mockStream: MockLive | null = null;
  private backoff = BACKOFF_MIN;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(readonly kind: "real" | "mock") {}

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
        // Grace period: survives StrictMode double-mount and client-side navigation between pages.
        this.stopTimer = setTimeout(() => {
          this.stopTimer = null;
          if (this.listeners.size === 0) this.stop();
        }, 1500);
      }
    };
  };

  getSnapshot = (): LiveState => this.state;

  /** Mock controls (dashboard buttons in mock mode); null for the real stream. */
  get mock(): MockControls | null {
    return this.mockStream;
  }

  private set(next: LiveState) {
    if (next === this.state) return;
    this.state = next;
    for (const l of this.listeners) l();
  }

  dispatch = (ev: LiveEvent) => {
    this.set(applyLive(this.state, ev));
  };

  private start() {
    this.running = true;
    if (this.kind === "mock") {
      this.mockStream = new MockLive(this.dispatch);
      this.set(withConnection(this.state, true, null));
      this.mockStream.start();
    } else {
      this.connect();
    }
  }

  private stop() {
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.mockStream?.stop();
    this.mockStream = null;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null;
      ws.close();
    }
    this.set(withConnection(this.state, false));
  }

  private connect() {
    if (typeof window === "undefined" || !this.running) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(liveUrl(this.state.focus));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = BACKOFF_MIN;
      this.set(withConnection(this.state, true, null));
    };
    ws.onmessage = (msg: MessageEvent) => {
      if (typeof msg.data !== "string") return;
      const ev = parseLive(msg.data);
      if (ev) this.dispatch(ev);
    };
    ws.onclose = (e: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.set(withConnection(this.state, false, e.code));
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

  /** Drop the socket and reconnect now (the server sends a fresh snapshot on connect). */
  reconnect() {
    if (this.kind === "mock") {
      this.mockStream?.resnapshot();
      return;
    }
    if (!this.running) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.backoff = BACKOFF_MIN;
    if (this.state.synced) this.set({ ...this.state, synced: false }); // the next socket's snapshot re-syncs
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    this.connect();
  }

  /** Focus a device (admin with several devices): reconnect with ?device_id=. */
  setFocus(deviceId: string | null) {
    if (deviceId === this.state.focus) return;
    const next = { ...initialLiveState(), focus: deviceId, knownDevices: this.state.knownDevices, connected: this.state.connected };
    this.set(next);
    this.reconnect();
  }
}

let realStore: LiveStore | null = null;
let mockStore: LiveStore | null = null;

export function getLiveStore(mock: boolean): LiveStore {
  if (mock) return (mockStore ??= new LiveStore("mock"));
  return (realStore ??= new LiveStore("real"));
}

const INITIAL = initialLiveState();
const idleSubscribe = () => () => {};
const idleSnapshot = () => INITIAL;

export interface UseLiveOptions {
  /** Force the mock stream (default: mock mode from env / ?mock=1). */
  mock?: boolean;
  /** false = don't connect at all (e.g. while auth is still loading). */
  enabled?: boolean;
}

export function useLive(opts: UseLiveOptions = {}): { state: LiveState; connected: boolean; store: LiveStore | null; mock: boolean } {
  const envMock = useMockMode();
  const mock = opts.mock ?? envMock;
  const enabled = opts.enabled ?? true;
  const store = enabled ? getLiveStore(mock) : null;
  const state = useSyncExternalStore(store ? store.subscribe : idleSubscribe, store ? store.getSnapshot : idleSnapshot, idleSnapshot);
  return { state, connected: state.connected, store, mock };
}
