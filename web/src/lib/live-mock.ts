// In-browser synthetic /ws/live stream for UI development and as a demo fallback (NEXT_PUBLIC_MOCK=1 or ?mock=1).
// It follows the real contract and the §13 story: A works at ~97% → takeover_start marker → trust falls
// ~0.07/tick with red why-chips → 2 ticks below 0.40 arm a proactive challenge → B's $2,000 purchase steps up →
// a cloned voice is blocked (BLOCK_SPOOF) and the device locks → A unlocks with voice → loop.
// Everything here is SIMULATED; the UI labels mock mode as such.
import {
  FEATURE_SPEC,
  TRUST_CONFIG,
  type BlockScored,
  type ChallengeLive,
  type ContextLive,
  type DeviationOut,
  type FeedItem,
  type HealthLive,
  type Level,
  type LiveEvent,
  type MarkerPoint,
  type Modality,
  type ModalityContribution,
  type Mode,
  type ModelInfo,
  type Snapshot,
  type TrustLive,
  type TrustPoint,
} from "./contracts";
import { randomId } from "./mode";

export interface MockControls {
  reset(): void;
  rearm(confidence?: number): void;
  setTakeover(on: boolean): void;
  setMode(mode: Mode): void;
  train(): void;
  unlock(): string;
  resnapshot(): void;
}

type Emit = (ev: LiveEvent) => void;

export const MOCK_DEVICE_ID = "mock-device-a";
const TICK_MS = 5000;
const TAKEOVER_AFTER_MS = 40_000;
const PSD_BINS = 32;

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];
function gauss(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const logit = (p: number) => Math.log(p / (1 - p));
const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Feature values (plausible, per unit) — used for last_tick_json, headline medians and context features.
// ---------------------------------------------------------------------------

const TYPICAL: Record<string, number> = {
  "kb.hold_p50": 96,
  "kb.hold_iqr": 28,
  "kb.hold_p50_L": 92,
  "kb.hold_p50_R": 99,
  "kb.hold_p50_space": 88,
  "kb.dd_p50": 162,
  "kb.dd_iqr": 74,
  "kb.ud_p50": 68,
  "kb.ud_iqr": 61,
  "kb.rollover_frac": 0.18,
  "kb.dd_p50_same_hand": 181,
  "kb.dd_p50_cross_hand": 139,
  "kb.dd_p50_letter_space": 128,
  "kb.dd_p50_space_letter": 171,
  "kb.tri_p50": 318,
  "kb.tri_iqr": 112,
  "kb.speed_kps": 6.1,
  "kb.burst_len_mean": 11.4,
  "kb.pause_rate": 0.07,
  "kb.bksp_rate": 0.06,
  "kb.bksp_run_mean": 1.6,
  "kb.pre_bksp_dd_p50": 241,
  "kb.post_bksp_dd_p50": 205,
  "kb.shift_lead_p50": 64,
  "kb.chord_rate": 0.03,
  "ms.v_p50": 0.62,
  "ms.v_p90": 1.84,
  "ms.a_p50": 7.9,
  "ms.jerk_p50": 180,
  "ms.curv_p50": 1.9,
  "ms.angvel_p50": 3.4,
  "ms.straightness_p50": 0.86,
  "ms.path_p50": 0.21,
  "ms.dur_p50": 410,
  "ms.t_peak_frac_p50": 0.38,
  "ms.submoves_p50": 2,
  "ms.click_hold_p50": 104,
  "ms.pre_click_pause_p50": 182,
  "ms.dblclick_p50": 212,
  "ms.frac_pc": 0.62,
  "ms.frac_dd": 0.08,
  "ms.dir_entropy": 2.6,
  "ms.dwell_rate": 0.9,
  "ms.dwell_p50": 340,
  "sc.burst_dur_p50": 520,
  "sc.burst_events_p50": 14,
  "sc.burst_dist_p50": 640,
  "sc.v_peak_p50": 2900,
  "sc.v_mean_p50": 1250,
  "sc.iei_cv_p50": 0.61,
  "sc.inter_burst_p50": 1450,
  "sc.reversal_rate": 0.12,
  "sc.momentum_frac": 0.44,
  "sc.horizontal_frac": 0.03,
  "wf.switch_rate": 2.4,
  "wf.switch_latency_p50": 780,
  "wf.kbd_switch_frac": 0.58,
  "wf.win_change_rate": 1.1,
  "wf.tab_chord_rate": 1.6,
  "wf.k2m_p50": 640,
  "wf.m2k_p50": 520,
  "wf.app_dwell_p50": 41000,
  "wf.markov_ll": -1.2,
  "tp.rate": 7.8,
  "tp.B": 0.31,
  "tp.Bn": 0.33,
  "tp.M": 0.12,
  "tp.idle_frac": 0.18,
  "tp.idle_p50": 1300,
  "tp.idle_p90": 4800,
  "tp.bp_0_05": 0.24,
  "tp.bp_05_2": 0.29,
  "tp.bp_2_5": 0.31,
  "tp.bp_5_10": 0.12,
  "tp.bp_10_25": 0.04,
  "tp.spec_entropy": 3.9,
  "tp.peak_hz": 3.2,
  "tp.centroid_hz": 3.9,
  "tp.acf_peak_lag": 310,
  "tp.acf_peak": 0.27,
};

function featureValues(m: Modality, impostor: boolean): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const f of FEATURE_SPEC.modalities[m].features) {
    const base = TYPICAL[f.name] ?? 1;
    if (f.name === "wf.markov_ll") {
      out[f.name] = null; // derived by the model; always null on the wire
      continue;
    }
    const shift = impostor ? 1 + rand(0.18, 0.4) * (Math.random() < 0.75 ? 1 : -1) : 1 + gauss() * 0.06;
    let v = base * shift;
    if (f.unit === "frac" || f.unit === "ratio" || f.unit === "corr") v = clamp(v, 0, 1);
    out[f.name] = Math.round(v * 1000) / 1000;
  }
  return out;
}

// ---------------------------------------------------------------------------
// PSD shapes (32 bins over 0–25 Hz)
// ---------------------------------------------------------------------------

function psdShape(peakHz: number, width: number, jitter: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < PSD_BINS; i++) {
    const f = (i * 25) / (PSD_BINS - 1);
    const pink = 0.35 / (1 + f * 0.9);
    const bump = Math.exp(-((f - peakHz) ** 2) / (2 * width * width));
    const harmonic = 0.28 * Math.exp(-((f - 2 * peakHz) ** 2) / (2 * (width * 1.4) ** 2));
    out.push(Math.max(1e-4, (pink + bump + harmonic) * (1 + gauss() * jitter)));
  }
  const sum = out.reduce((a, b) => a + b, 0);
  return out.map((v) => v / sum);
}

// ---------------------------------------------------------------------------
// Deviations ("why" chips)
// ---------------------------------------------------------------------------

const WHY_FEATURES: Record<Modality, string[]> = {
  keyboard: ["kb.dd_p50", "kb.hold_p50", "kb.ud_p50", "kb.dd_p50_cross_hand", "kb.tri_p50", "kb.speed_kps", "kb.bksp_rate", "kb.dd_p50_space_letter"],
  mouse: ["ms.curv_p50", "ms.v_p50", "ms.click_hold_p50", "ms.straightness_p50", "ms.pre_click_pause_p50", "ms.jerk_p50", "ms.dwell_p50"],
  scroll: ["sc.v_mean_p50", "sc.burst_dur_p50", "sc.inter_burst_p50", "sc.reversal_rate"],
  workflow: ["wf.switch_latency_p50", "wf.k2m_p50", "wf.m2k_p50", "wf.switch_rate"],
  temporal: ["tp.B", "tp.peak_hz", "tp.idle_frac", "tp.rate"],
};

const SPEC_INDEX: Record<string, { label: string; unit: string }> = {};
for (const ms of Object.values(FEATURE_SPEC.modalities)) for (const f of ms.features) SPEC_INDEX[f.name] = { label: f.label, unit: f.unit };

function deviations(m: Modality, impostor: boolean): DeviationOut[] {
  const names = [...WHY_FEATURES[m]].sort(() => Math.random() - 0.5).slice(0, 3);
  return names
    .map((feature) => {
      const z = impostor ? (Math.random() < 0.8 ? 1 : -1) * rand(2.5, 3.5) : gauss() * 0.9;
      return { feature, label: SPEC_INDEX[feature]?.label ?? feature, unit: SPEC_INDEX[feature]?.unit ?? "", z: Math.round(z * 100) / 100 };
    })
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}

/** A server-style `feed` line for the mock stream (the real feed is server-authored). */
export function mockFeedEvent(type: string, text: string, severity: number): LiveEvent {
  const t = iso(Date.now());
  return { type: "feed", device_id: MOCK_DEVICE_ID, t, data: { t, type, text, severity } };
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

type Phase = "genuine" | "takeover" | "locked";

const N_REF: Record<Modality, number> = {
  keyboard: FEATURE_SPEC.modalities.keyboard.n_ref,
  mouse: FEATURE_SPEC.modalities.mouse.n_ref,
  scroll: FEATURE_SPEC.modalities.scroll.n_ref,
  workflow: FEATURE_SPEC.modalities.workflow.n_ref,
  temporal: FEATURE_SPEC.modalities.temporal.n_ref,
};

export class MockLive implements MockControls {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private conf = 0.97;
  private phase: Phase = "genuine";
  private mode: Mode = "monitor";
  private auto = true;
  private cycleStart = Date.now();
  private below = 0;
  private challenge: ChallengeLive | null = null;
  private armedAt: number | null = null;
  private anomalyId: string | null = null;
  private decisionId: string | null = null;
  private lockedAt: number | null = null;
  private attacker = false;
  private seq = 0;
  private sessionId = randomId();
  private runId = randomId();
  private modelVersion = 4;
  private learned = 37;
  private history: TrustPoint[] = [];
  private markers: MarkerPoint[] = [];
  private feedItems: FeedItem[] = [];
  private enrolledPsd = psdShape(3.2, 1.1, 0);
  private lastBlockAt: Partial<Record<Modality, number>> = {};
  private lastLevel: Level = "normal";

  constructor(private readonly emit: Emit) {}

  // ---- lifecycle ----
  start() {
    this.prefillHistory();
    this.emitSnapshot();
    this.later(600, () => this.tick());
    this.interval = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers = this.timers.filter((x) => x !== t);
      fn();
    }, ms);
    this.timers.push(t);
  }

  private send<T extends LiveEvent["type"]>(type: T, data: Extract<LiveEvent, { type: T }>["data"], t = Date.now()) {
    this.emit({ type, device_id: MOCK_DEVICE_ID, t: iso(t), data } as LiveEvent);
  }

  // ---- state builders ----
  private level(): Level {
    if (this.phase === "locked") return "locked";
    if (this.mode === "enroll") return "learning";
    if (this.conf >= TRUST_CONFIG.levels.normal) return "normal";
    if (this.conf >= TRUST_CONFIG.levels.watch) return "watch";
    return "suspicious";
  }

  private model(status: ModelInfo["status"] = "ready"): ModelInfo {
    const enabled: Modality[] = ["keyboard", "mouse", "scroll"]; // workflow/temporal are captured, not scored (like live)
    const headline: Record<string, number | null> = {};
    for (const m of enabled) {
      for (const f of FEATURE_SPEC.modalities[m].features) if (f.headline) headline[f.column] = TYPICAL[f.name] ?? null; // keyed by column
    }
    return {
      status,
      backend: "twobme_ml",
      job_id: randomId(),
      version: this.modelVersion,
      trained_at: iso(Date.now() - 42 * 60_000),
      n_blocks: { keyboard: 412, mouse: 388, scroll: 96, workflow: 61, temporal: 240 },
      enabled_modalities: enabled,
      metrics: { eer_keyboard: 0.16, eer_mouse: 0.23, fused_eer: 0.09 },
      headline_medians: headline,
      learned_since_enroll: this.learned,
      parent_version: this.modelVersion - 1,
      error: null,
    };
  }

  private health(): HealthLive {
    const now = Date.now();
    const ages: Partial<Record<Modality, number | null>> = {};
    for (const m of ["keyboard", "mouse", "scroll", "workflow", "temporal"] as Modality[]) {
      const at = this.lastBlockAt[m];
      ages[m] = at ? Math.round((now - at) / 100) / 10 : null;
    }
    return {
      heartbeat_age_s: Math.round(rand(0.4, 2.6) * 10) / 10,
      tap_events_per_s: Math.round(rand(6, 14) * 10) / 10,
      secure_input: false,
      last_block_age_s: ages,
      rtt_ms: Math.round(rand(34, 62)),
      voice_warm: true,
      elevenlabs_quota: 0.42,
      activity: Array.from({ length: 5 }, () => Math.round(rand(2, 14))),
      last_tick_json: this.tickJson(), // per-tick, like the server's health event
    };
  }

  private tickJson(): Record<string, unknown> {
    const now = Date.now();
    const impostor = this.phase === "takeover";
    const block = (m: Modality, n: number) => ({
      modality: m,
      t_start: iso(now - rand(3000, 9000)),
      t_end: iso(now - rand(100, 900)),
      n,
      features: featureValues(m, impostor),
      transitions: m === "workflow" ? { "ide>browser": 1, "browser>ide": 1 } : null,
      psd: null,
    });
    return {
      type: "tick",
      run_id: this.runId,
      session_id: this.sessionId,
      seq: this.seq,
      t_end: iso(now),
      flags: { secure_input: false, injected: 0, pointer: "trackpad", late: false, idle_s: 0.0, clock_skew: false },
      counts: { keys: 24, mouse_moves: 410, clicks: 2, scroll_events: 0, app_switches: 0 },
      activity: [5, 7, 3, 0, 4],
      blocks: [block("keyboard", 20), block("mouse", 6)],
      context: {
        modality: "temporal",
        t_start: iso(now - 30_000),
        t_end: iso(now),
        n: 312,
        features: featureValues("temporal", impostor),
        transitions: null,
        psd: psdShape(impostor ? 1.6 : 3.2, impostor ? 1.8 : 1.1, 0.12).map((v) => Math.round(v * 1e4) / 1e4),
      },
    };
  }

  private trustLive(perModality: Partial<Record<Modality, ModalityContribution>> = {}, delta = 0): TrustLive {
    const conf = this.conf;
    return {
      t: Date.now() / 1000,
      logit: logit(conf),
      delta_logit: delta,
      confidence: conf,
      display: Math.min(99, Math.round(conf * 100)),
      level: this.level(),
      per_modality: perModality,
      reasons: [],
      seq: this.seq,
      locked: this.phase === "locked",
    };
  }

  private prefillHistory() {
    const now = Date.now();
    this.history = [];
    let c = 0.972;
    for (let t = now - 4 * 60_000; t < now; t += TICK_MS) {
      c = clamp(c + gauss() * 0.006 + (0.972 - c) * 0.3, 0.945, 0.99);
      this.history.push({ t: iso(t), confidence: c, level: "normal" });
    }
    this.conf = c;
    this.feedItems = [
      { t: iso(now - 3.8 * 60_000), type: "session", text: "Session started · agent 0.1.0 · trackpad", severity: 0 },
      { t: iso(now - 3.5 * 60_000), type: "model", text: `Identity model v${this.modelVersion} active · +${this.learned} blocks learned`, severity: 1 },
      { t: iso(now - 60_000), type: "decision", text: "Purchase $2,000.00 → Y (approved) at 97% · R3 · co-present", severity: 0 },
    ];
  }

  private snapshot(): Snapshot {
    return {
      recent_blocks: [],
      device: {
        id: MOCK_DEVICE_ID,
        label: "A's MacBook Pro (simulated)",
        pointer: "trackpad",
        mode: this.mode,
        locked: this.phase === "locked",
        lock_reason: this.phase === "locked" ? "voice_spoof" : null,
        last_seen: iso(Date.now()),
      },
      session_id: this.sessionId,
      label: this.attacker ? "impostor" : "genuine",
      actor: this.attacker ? "b" : "a",
      trust: this.trustLive(),
      trust_history: this.history.slice(),
      markers: this.markers.slice(),
      model: this.model(),
      enroll: {
        mode: this.mode,
        counts: { keyboard: 412, mouse: 388, scroll: 96, workflow: 61, temporal: 240 },
        gates: {
          keyboard: FEATURE_SPEC.modalities.keyboard.enroll_gate,
          mouse: FEATURE_SPEC.modalities.mouse.enroll_gate,
          scroll: FEATURE_SPEC.modalities.scroll.enroll_gate,
          workflow: FEATURE_SPEC.modalities.workflow.enroll_gate,
          temporal: FEATURE_SPEC.modalities.temporal.enroll_gate,
        },
        ready: true,
      },
      open_challenge: this.challenge,
      recent_events: this.feedItems.slice(),
      last_tick_json: this.tickJson(),
      health: this.health(),
      enrolled_psd: this.enrolledPsd,
    };
  }

  private emitSnapshot() {
    this.send("snapshot", this.snapshot());
  }

  /** Emit a server-style feed line (severity 0 info · 1 notice · 2 warn · 3 alert · 4 high · 5 lock). */
  private say(type: string, text: string, severity: number) {
    const ev = mockFeedEvent(type, text, severity);
    if (ev.type === "feed") this.feedItems = [ev.data, ...this.feedItems].slice(0, 50);
    this.emit(ev);
  }

  private addMarker(label: MarkerPoint["label"], text: string | null = null) {
    const m: MarkerPoint = { t: iso(Date.now()), label, text };
    this.markers = [...this.markers, m].filter((x) => Date.parse(x.t) > Date.now() - 10 * 60_000);
    this.send("marker", m);
  }

  private pushTrust(perModality: Partial<Record<Modality, ModalityContribution>>, delta: number) {
    const tl = this.trustLive(perModality, delta);
    this.history = [...this.history, { t: iso(tl.t * 1000), confidence: tl.confidence, level: tl.level }].filter(
      (p) => Date.parse(p.t) > Date.now() - 10 * 60_000,
    );
    this.send("trust", tl);
    // Server-style trust lines: only "→ suspicious" and "recovered".
    if (tl.level !== this.lastLevel) {
      if (tl.level === "suspicious") this.say("trust", `Trust → suspicious · ${Math.round(tl.confidence * 100)}%`, 3);
      else if (tl.level === "normal" && (this.lastLevel === "suspicious" || this.lastLevel === "watch" || this.lastLevel === "locked"))
        this.say("trust", `Trust recovered · ${Math.round(tl.confidence * 100)}%`, 1);
      this.lastLevel = tl.level;
    }
  }

  // ---- the 5 s tick ----
  private tick() {
    const now = Date.now();
    this.seq += 1;
    // B stays at the keyboard while the device is locked (blocks are still scored, display only).
    const impostor = this.phase === "takeover" || (this.phase === "locked" && this.attacker);

    // Autoplay script (disabled once someone presses a control).
    if (this.auto && this.phase === "genuine" && now - this.cycleStart >= TAKEOVER_AFTER_MS) this.startTakeover();

    // Blocks for this tick.
    const want: Modality[] = [];
    if (Math.random() < 0.9) want.push("keyboard");
    if (Math.random() < 0.8) want.push("mouse");
    if (Math.random() < 0.22) want.push("scroll");
    if (Math.random() < 0.15) want.push("workflow");
    const perModality: Partial<Record<Modality, ModalityContribution>> = {};
    let deltaSum = 0;
    for (const m of want) {
      const n = m === "keyboard" ? 20 : m === "mouse" ? Math.round(rand(4, 9)) : Math.round(rand(2, 5));
      const typ = impostor ? 1 - Math.pow(Math.random(), 1 / 6) : rand(0.12, 1);
      const beta = 6;
      const llr = clamp(-Math.log(beta) - (beta - 1) * Math.log(1 - Math.min(typ, 1 - 1e-6)), -4, 4);
      const q = Math.min(1, n / N_REF[m]);
      const w = TRUST_CONFIG.weights[m];
      const delta = 0.5 * w * q * Math.tanh(llr);
      deltaSum += delta;
      perModality[m] = { typicality: typ, llr, q, w, delta, n_blocks: 1 };
      const block: BlockScored = {
        modality: m,
        t_start: iso(now - rand(3500, 9000)),
        t_end: iso(now - rand(100, 800)),
        n,
        typicality: Math.round(typ * 1000) / 1000,
        llr: Math.round(llr * 100) / 100,
        q,
        delta: Math.round(delta * 1000) / 1000,
        top: deviations(m, impostor),
      };
      this.lastBlockAt[m] = now;
      this.send("block_scored", block);
    }
    // Temporal context every tick (30 s window, 32-bin PSD).
    this.lastBlockAt.temporal = now;
    const psd = psdShape(impostor ? rand(1.3, 1.9) : rand(2.9, 3.5), impostor ? 1.8 : 1.1, 0.14);
    const context: ContextLive = { psd, features: featureValues("temporal", impostor), enrolled_psd: this.enrolledPsd };
    this.send("context", context);
    perModality.temporal = { typicality: impostor ? 0.2 : 0.6, llr: impostor ? -0.8 : 0.4, q: 1, w: 0.05, delta: impostor ? -0.02 : 0.01, n_blocks: 1 };

    // Confidence dynamics (display-level, not the real engine).
    if (this.phase === "genuine") {
      const target = 0.972;
      this.conf = clamp(this.conf + (target - this.conf) * (this.conf < 0.9 ? 0.18 : 0.35) + gauss() * 0.006, 0.05, 0.99);
    } else if (this.phase === "takeover") {
      this.conf = clamp(this.conf - rand(0.05, 0.09), 0.06, 0.99);
    } else {
      this.conf = 0.005; // locked: L pinned to its minimum
    }
    if (this.mode === "enroll" && this.phase !== "locked") this.conf = clamp(this.conf, 0.9, 0.99);
    this.pushTrust(perModality, deltaSum);

    this.send("health", this.health());
    if (now % 4 === 0) this.send("presence", { binding: "co-present", score: Math.round(rand(0.62, 0.88) * 100) / 100 });

    // Arming: 2 consecutive ticks below 0.40 → proactive challenge (+ anomaly).
    if (this.phase === "takeover" && this.mode === "monitor") {
      this.below = this.conf < TRUST_CONFIG.arming.threshold ? this.below + 1 : 0;
      if (this.below >= TRUST_CONFIG.arming.consecutive_ticks && !this.challenge) this.arm();
    }

    if (this.auto) this.autoplay(now);
  }

  private autoplay(now: number) {
    if (this.phase === "takeover" && this.armedAt && !this.decisionId && now - this.armedAt >= 12_000) this.attackerPurchase();
    if (this.phase === "takeover" && this.decisionId && this.challenge && now - this.armedAt! >= 22_000) this.cloneAttack();
    if (this.phase === "locked" && this.lockedAt && now - this.lockedAt >= 22_000) this.unlock();
  }

  private startTakeover() {
    this.phase = "takeover";
    this.attacker = true;
    this.addMarker("takeover_start");
    this.say("marker", "Operator marked takeover start — ground truth only, never scored", 2);
    this.send("label", { label: "impostor", actor: "b" });
    this.say("label", "Label → impostor (actor b)", 1);
  }

  private arm() {
    const id = `mock-ch-${randomId().slice(0, 8)}`;
    this.armedAt = Date.now();
    this.challenge = {
      challenge_id: id,
      trigger: "proactive",
      status: "issued",
      attempt: 1,
      expires_at: iso(Date.now() + TRUST_CONFIG.arming.proactive_expiry_s * 1000),
      verify_url: `/verify?c=${id}`,
    };
    this.anomalyId = `mock-an-${randomId().slice(0, 8)}`;
    const top: DeviationOut[] = [
      { feature: "kb.dd_p50", label: "flight time", unit: "ms", z: 3.1 },
      { feature: "ms.curv_p50", label: "path curvature", unit: "rad/dd", z: 2.8 },
      { feature: "kb.hold_p50", label: "key hold", unit: "ms", z: -2.4 },
    ];
    const anomaly = {
      id: this.anomalyId,
      kind: "takeover_suspected" as const,
      severity: 4,
      trust_before: 0.97,
      trust_after: Math.round(this.conf * 100) / 100,
      top_features: top,
      action: "challenge_armed",
      challenge_id: id,
      explanation: null,
    };
    this.send("anomaly", anomaly);
    this.say("anomaly", `Anomaly: takeover suspected · ${Math.round(this.conf * 100)}% · flight time +3.1σ`, 4);
    this.send("challenge", this.challenge);
    this.say("challenge", "Challenge armed — trust below 40% for 2 ticks; voice check requested", 3);
    this.later(7000, () => {
      if (this.anomalyId !== anomaly.id) return;
      this.send("anomaly", {
        ...anomaly,
        explanation:
          "Typing rhythm shifted sharply: flight time between keys ran about 3 standard deviations slower than this user's baseline, and pointer paths curved more than usual. Together these point to a different person at the keyboard. (simulated explanation)",
      });
    });
  }

  private attackerPurchase() {
    if (!this.challenge) return;
    this.decisionId = `mock-dec-${randomId().slice(0, 8)}`;
    this.send("decision", {
      decision_id: this.decisionId,
      status: "pending",
      decision: "step_up",
      trans_status: "C",
      confidence: this.conf,
      tier: "R3",
      binding: "co-present",
      reasons: [`confidence ${this.conf.toFixed(2)} < 0.90 (R3)`],
      challenge_id: this.challenge.challenge_id,
      verify_url: this.challenge.verify_url,
      action: "purchase",
      amount_cents: 200_000,
    });
    this.say("decision", `Purchase $2,000.00 → C step-up at ${Math.round(this.conf * 100)}% · R3 · co-present`, 2);
  }

  private cloneAttack() {
    const ch = this.challenge;
    if (!ch) return;
    const id = ch.challenge_id;
    this.challenge = { ...ch, status: "prompt_ended" };
    this.send("challenge", this.challenge);
    this.say("challenge", "Voice prompt played (attempt 1)", 1);
    this.later(600, () => this.send("voice_stage", { challenge_id: id, stage: "transcribing", ok: true, value: 0.0 }));
    this.later(1300, () => this.send("voice_stage", { challenge_id: id, stage: "anti-spoof", ok: false, value: 0.93 }));
    this.later(1900, () => this.send("voice_stage", { challenge_id: id, stage: "speaker", ok: true, value: 0.58 }));
    this.later(2400, () => this.send("voice_stage", { challenge_id: id, stage: "spectral", ok: false, value: 0.71 }));
    this.later(2800, () => {
      this.send("voice_stage", { challenge_id: id, stage: "done", ok: false, value: null });
      this.send("voice_result", {
        challenge_id: id,
        decision: "BLOCK_SPOOF",
        simulated: true,
        voice_confidence: 0.07,
        asv_cos: 0.58,
        cm_p_spoof: 0.93,
        spec_sim: 0.71,
        phrase_wer: 0.0,
        onset_ms: 212,
        dsp: { hnr_db: 21.4, jitter_pct: 0.31, shimmer_pct: 1.9, hf_energy_ratio: 0.012 },
        findings: ["High-band energy above 7 kHz is missing (vocoder band-limit)", "Pitch jitter unusually low for live speech"],
        stage_ms: { stt: 640, cm: 410, asv: 220, dsp: 90 },
      });
      this.say("voice", "Voice result BLOCK_SPOOF · speaker 0.58 · synthetic 0.93", 4);
      this.challenge = null;
      this.send("challenge", { ...ch, status: "blocked_spoof" });
      if (this.decisionId) {
        this.send("decision", {
          decision_id: this.decisionId,
          status: "final",
          decision: "block",
          trans_status: "N",
          confidence: 0.005,
          tier: "R3",
          binding: "co-present",
          reasons: ["voice_spoof", "device_locked"],
          challenge_id: id,
          verify_url: null,
          action: "purchase",
          amount_cents: 200_000,
        });
        this.say("decision", "Purchase $2,000.00 → N declined — voice spoof, device locked", 4);
      }
      this.phase = "locked";
      this.lockedAt = Date.now();
      this.send("lock", { reason: "voice_spoof" });
      this.say("lock", "Device locked — synthetic (cloned) voice", 5);
      this.conf = 0.005;
      this.pushTrust({}, 0);
    });
  }

  // ---- controls (dashboard buttons in mock mode) ----
  unlock(): string {
    const id = `mock-ch-${randomId().slice(0, 8)}`;
    const ch: ChallengeLive = { challenge_id: id, trigger: "unlock", status: "issued", attempt: 1, expires_at: iso(Date.now() + 120_000), verify_url: `/verify?c=${id}` };
    this.send("challenge", ch);
    this.say("challenge", "Unlock challenge issued", 1);
    if (this.attacker) {
      this.addMarker("takeover_end");
      this.say("marker", "Operator marked takeover end", 1);
    }
    this.attacker = false;
    this.send("label", { label: "genuine", actor: "a" });
    this.say("label", "Label → genuine (actor a)", 1);
    this.later(2500, () => {
      this.send("voice_result", {
        challenge_id: id,
        decision: "VERIFY",
        simulated: true,
        voice_confidence: 0.96,
        asv_cos: 0.81,
        cm_p_spoof: 0.04,
        spec_sim: 0.92,
        phrase_wer: 0.0,
        onset_ms: 380,
        dsp: { hnr_db: 17.2, jitter_pct: 0.74, shimmer_pct: 3.1, hf_energy_ratio: 0.041 },
        findings: [],
        stage_ms: { stt: 610, cm: 400, asv: 210, dsp: 85 },
      });
      this.say("voice", "Voice result VERIFY · speaker 0.81 · synthetic 0.04", 0);
      this.send("challenge", { ...ch, status: "verified" });
      this.phase = "genuine";
      this.lockedAt = null;
      this.armedAt = null;
      this.decisionId = null;
      this.anomalyId = null;
      this.below = 0;
      this.conf = 0.97;
      this.cycleStart = Date.now();
      this.send("unlock", {});
      this.say("unlock", "Device unlocked — owner verified by voice, trust anchored at 97%", 1);
      this.pushTrust({}, 0);
    });
    return id;
  }

  reset() {
    this.auto = false;
    this.clearAttack();
    this.phase = "genuine";
    this.conf = 0.97;
    this.sessionId = randomId();
    this.addMarker("reset");
    this.history = [...this.history, { t: iso(Date.now()), confidence: 0.97, level: "normal" }];
    this.feedItems = [{ t: iso(Date.now()), type: "operator", text: "Operator reset — new session, trust anchored at 97%", severity: 1 }];
    this.emitSnapshot();
  }

  rearm(confidence = TRUST_CONFIG.anchors.rearm_default) {
    this.auto = false;
    this.conf = confidence;
    this.addMarker("rearm");
    this.say("operator", `Operator re-armed trust to ${Math.round(confidence * 100)}%`, 1);
    this.pushTrust({}, 0);
  }

  setTakeover(on: boolean) {
    this.auto = false;
    if (on && this.phase === "genuine") this.startTakeover();
    else if (!on && this.attacker) {
      this.attacker = false;
      if (this.phase === "takeover") this.phase = "genuine";
      this.addMarker("takeover_end");
      this.say("marker", "Operator marked takeover end", 1);
      this.send("label", { label: "genuine", actor: "a" });
      this.say("label", "Label → genuine (actor a)", 1);
    }
  }

  setMode(mode: Mode) {
    this.mode = mode;
    this.send("mode", { mode });
    this.say("mode", `Mode → ${mode}`, 1);
  }

  train() {
    this.send("model", { ...this.model("training") });
    this.say("model", "Training identity model…", 1);
    this.later(2500, () => {
      this.modelVersion += 1;
      this.learned = 0;
      this.mode = "monitor";
      this.send("model", this.model("ready"));
      this.say("model", `Identity model v${this.modelVersion} active`, 1);
      this.send("mode", { mode: "monitor" });
    });
  }

  resnapshot() {
    this.emitSnapshot();
  }

  private clearAttack() {
    this.attacker = false;
    if (this.challenge) {
      this.send("challenge", { ...this.challenge, status: "cancelled" });
      this.say("challenge", "Challenge cancelled", 0);
    }
    if (this.phase === "locked") this.send("unlock", {});
    this.challenge = null;
    this.armedAt = null;
    this.anomalyId = null;
    this.decisionId = null;
    this.lockedAt = null;
    this.below = 0;
  }
}
