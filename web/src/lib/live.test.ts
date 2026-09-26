import { describe, expect, it } from "vitest";

import type { AnomalyLive, BlockScored, LiveEvent, Snapshot, TrustLive } from "./contracts";
import { FEED_MAX, applyLive, initialLiveState, parseLive, type LiveState } from "./live";
import { computeTtd, takeoverIntervals } from "./ttd";

const DEV = "dev-1";
const T0 = Date.parse("2026-09-26T14:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function ev<T extends LiveEvent["type"]>(type: T, data: Extract<LiveEvent, { type: T }>["data"], t = T0, device_id: string | null = DEV): LiveEvent {
  return { type, device_id, t: iso(t), data } as LiveEvent;
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    recent_blocks: [],
    device: { id: DEV, label: "A's MacBook", pointer: "trackpad", mode: "monitor", locked: false, lock_reason: null, last_seen: iso(T0) },
    session_id: "sess-1",
    label: "genuine",
    actor: "a",
    trust: trust(0.97, T0),
    trust_history: [{ t: iso(T0 - 5000), confidence: 0.96, level: "normal" }],
    markers: [],
    model: null,
    enroll: null,
    open_challenge: null,
    recent_events: [
      { t: iso(T0 - 60_000), type: "x", text: "older", severity: 0 },
      { t: iso(T0 - 1000), type: "x", text: "newer", severity: 0 },
    ],
    last_tick_json: { type: "tick", seq: 1 },
    health: null,
    enrolled_psd: null,
    ...overrides,
  };
}

function trust(confidence: number, ms: number, level: TrustLive["level"] = "normal", locked = false): TrustLive {
  return {
    t: ms / 1000,
    logit: Math.log(confidence / (1 - confidence)),
    delta_logit: 0,
    confidence,
    display: Math.min(99, Math.round(confidence * 100)),
    level,
    per_modality: {},
    reasons: [],
    seq: null,
    locked,
  };
}

function anomaly(id: string, explanation: string | null = null): AnomalyLive {
  return {
    id,
    kind: "takeover_suspected",
    severity: 4,
    trust_before: 0.97,
    trust_after: 0.35,
    top_features: [{ feature: "kb.dd_p50", label: "flight time", unit: "ms", z: 3.1 }],
    action: "challenge_armed",
    challenge_id: "ch-1",
    explanation,
  };
}

function block(modality: BlockScored["modality"], ms: number): BlockScored {
  return { modality, t_start: iso(ms - 4000), t_end: iso(ms), n: 20, typicality: 0.5, llr: 0.5, q: 1, delta: 0.1, top: [] };
}

describe("applyLive — snapshot", () => {
  it("replaces everything with the snapshot", () => {
    let s: LiveState = initialLiveState();
    s = applyLive(s, ev("block_scored", block("keyboard", T0)));
    s = applyLive(s, ev("anomaly", anomaly("a1")));
    expect(s.blocks).toHaveLength(1);

    s = applyLive(s, ev("snapshot", snapshot()));
    expect(s.device?.id).toBe(DEV);
    expect(s.session_id).toBe("sess-1");
    expect(s.trust?.confidence).toBe(0.97);
    expect(s.trust_history).toHaveLength(1);
    expect(s.blocks).toHaveLength(0);
    expect(s.anomalies).toHaveLength(0);
    expect(s.lastBlocks).toEqual({});
    expect(s.last_tick_json).toEqual({ type: "tick", seq: 1 });
    // recent_events sorted newest first
    expect(s.recent.map((r) => r.text)).toEqual(["newer", "older"]);
    // focus locks onto the snapshot's device
    expect(s.focus).toBe(DEV);
  });

  it("a second snapshot fully replaces the first", () => {
    let s = applyLive(initialLiveState(), ev("snapshot", snapshot()));
    s = applyLive(s, ev("trust", trust(0.5, T0 + 5000, "watch")));
    s = applyLive(s, ev("snapshot", snapshot({ session_id: "sess-2", trust_history: [], label: "impostor", actor: "b" })));
    expect(s.session_id).toBe("sess-2");
    expect(s.trust_history).toHaveLength(0);
    expect(s.label).toBe("impostor");
    expect(s.actor).toBe("b");
  });

  it("ignores events for other devices once focused", () => {
    let s = applyLive(initialLiveState(), ev("snapshot", snapshot()));
    const before = s.trust_history.length;
    s = applyLive(s, ev("trust", trust(0.1, T0 + 5000, "suspicious"), T0 + 5000, "dev-2"));
    expect(s.trust_history).toHaveLength(before);
    expect(Object.keys(s.knownDevices).sort()).toEqual([DEV, "dev-2"]);
  });
});

describe("applyLive — trust", () => {
  it("appends to trust_history and updates trust", () => {
    let s = applyLive(initialLiveState(), ev("snapshot", snapshot()));
    s = applyLive(s, ev("trust", trust(0.9, T0 + 5000)));
    expect(s.trust?.confidence).toBe(0.9);
    expect(s.trust_history).toHaveLength(2);
    expect(s.trust_history[1]).toEqual({ t: iso(T0 + 5000), confidence: 0.9, level: "normal" });
  });

  it("trims history to the last 10 minutes", () => {
    let s = applyLive(initialLiveState(), ev("snapshot", snapshot({ trust_history: [] })));
    for (let i = 0; i <= 150; i++) s = applyLive(s, ev("trust", trust(0.97, T0 + i * 5000), T0 + i * 5000));
    // 150 ticks × 5 s = 12.5 min; keep points within 10 min of the newest (inclusive) → 121
    expect(s.trust_history).toHaveLength(121);
    const first = Date.parse(s.trust_history[0].t);
    const last = Date.parse(s.trust_history[s.trust_history.length - 1].t);
    expect(last - first).toBe(10 * 60 * 1000);
  });

  it("never derives feed lines (the feed is server-authored)", () => {
    let s = applyLive(initialLiveState(), ev("snapshot", snapshot({ recent_events: [] })));
    s = applyLive(s, ev("trust", trust(0.96, T0 + 5000, "normal")));
    s = applyLive(s, ev("trust", trust(0.3, T0 + 10_000, "suspicious")));
    s = applyLive(s, ev("marker", { t: iso(T0 + 11_000), label: "takeover_start", text: null }));
    s = applyLive(s, ev("label", { label: "impostor", actor: "b" }));
    s = applyLive(s, ev("mode", { mode: "monitor" }));
    s = applyLive(s, ev("lock", { reason: "voice_spoof" }));
    s = applyLive(s, ev("unlock", {}));
    s = applyLive(s, ev("anomaly", anomaly("a1")));
    s = applyLive(s, ev("challenge", { challenge_id: "ch-1", trigger: "proactive", status: "issued", attempt: 1, expires_at: null, verify_url: null }));
    expect(s.recent).toHaveLength(0);
    // …but every state update still lands
    expect(s.trust?.level).toBe("suspicious");
    expect(s.markers).toHaveLength(1);
    expect(s.label).toBe("impostor");
    expect(s.anomalies).toHaveLength(1);
    expect(s.open_challenge?.challenge_id).toBe("ch-1");
  });

  it("locked trust is recorded with level 'locked'", () => {
    let s = applyLive(initialLiveState(), ev("snapshot", snapshot()));
    s = applyLive(s, ev("trust", trust(0.005, T0 + 5000, "suspicious", true)));
    expect(s.trust_history.at(-1)?.level).toBe("locked");
    expect(s.device?.locked).toBe(true);
  });
});

describe("applyLive — anomalies and feed", () => {
  it("a re-sent anomaly with the same id replaces in place", () => {
    let s = applyLive(initialLiveState(), ev("snapshot", snapshot({ recent_events: [] })));
    s = applyLive(s, ev("anomaly", anomaly("a1"), T0 + 1000));
    s = applyLive(s, ev("anomaly", anomaly("a2"), T0 + 2000));
    expect(s.anomalies.map((a) => a.id)).toEqual(["a2", "a1"]);
    const feedLen = s.recent.length;

    s = applyLive(s, ev("anomaly", anomaly("a1", "Typing rhythm changed."), T0 + 9000));
    expect(s.anomalies).toHaveLength(2);
    expect(s.anomalies.map((a) => a.id)).toEqual(["a2", "a1"]);
    expect(s.anomalies[1].explanation).toBe("Typing rhythm changed.");
    // keeps the original arrival time and doesn't add another feed line
    expect(s.anomalies[1].t).toBe(iso(T0 + 1000));
    expect(s.recent).toHaveLength(feedLen);
  });

  it("feed events are kept verbatim, newest first, capped", () => {
    let s = applyLive(initialLiveState(), ev("snapshot", snapshot({ recent_events: [] })));
    for (let i = 0; i < FEED_MAX + 10; i++) s = applyLive(s, ev("feed", { t: iso(T0 + i), type: "note", text: `line ${i}`, severity: 0 }));
    expect(s.recent).toHaveLength(FEED_MAX);
    expect(s.recent[0].text).toBe(`line ${FEED_MAX + 9}`);
  });

  it("terminal challenge status clears open_challenge", () => {
    let s = applyLive(initialLiveState(), ev("snapshot", snapshot()));
    const ch = { challenge_id: "ch-1", trigger: "proactive" as const, status: "issued" as const, attempt: 1, expires_at: null, verify_url: "/verify?c=ch-1" };
    s = applyLive(s, ev("challenge", ch));
    expect(s.open_challenge?.challenge_id).toBe("ch-1");
    s = applyLive(s, ev("challenge", { ...ch, status: "blocked_spoof" }));
    expect(s.open_challenge).toBeNull();
  });

  it("lock/unlock toggle device.locked", () => {
    let s = applyLive(initialLiveState(), ev("snapshot", snapshot()));
    s = applyLive(s, ev("lock", { reason: "voice_spoof" }));
    expect(s.device?.locked).toBe(true);
    expect(s.device?.lock_reason).toBe("voice_spoof");
    s = applyLive(s, ev("unlock", {}));
    expect(s.device?.locked).toBe(false);
  });
});

describe("parseLive", () => {
  it("accepts valid envelopes and rejects junk", () => {
    expect(parseLive('{"type":"feed","device_id":null,"t":"2026-09-26T14:00:00.000Z","data":{"t":"x","type":"n","text":"hi","severity":0}}')?.type).toBe("feed");
    expect(parseLive('{"type":"nope","data":{}}')).toBeNull();
    expect(parseLive("not json")).toBeNull();
    expect(parseLive('{"type":"trust"}')).toBeNull();
  });
});

describe("TTD stopwatch", () => {
  const markers = [{ t: iso(T0), label: "takeover_start" as const, text: null }];
  const history = [
    { t: iso(T0 - 5000), confidence: 0.97, level: "normal" as const },
    { t: iso(T0 + 20_000), confidence: 0.62, level: "watch" as const },
    { t: iso(T0 + 38_000), confidence: 0.36, level: "suspicious" as const },
    { t: iso(T0 + 43_000), confidence: 0.3, level: "suspicious" as const },
  ];
  const blocks = [block("keyboard", T0 - 1000), block("keyboard", T0 + 5000), block("mouse", T0 + 6000), block("keyboard", T0 + 30_000), block("keyboard", T0 + 40_000)];

  it("freezes at the first tick below 0.40 and counts blocks in the interval", () => {
    const r = computeTtd(markers, history, blocks, T0 + 60_000);
    expect(r.status).toBe("detected");
    expect(r.seconds).toBe(38);
    expect(r.counts).toEqual({ keyboard: 2, mouse: 1 });
  });

  it("runs while not yet detected", () => {
    const r = computeTtd(markers, history.slice(0, 2), blocks, T0 + 25_000);
    expect(r.status).toBe("running");
    expect(r.seconds).toBe(25);
  });

  it("is idle without a takeover marker", () => {
    expect(computeTtd([], history, blocks).status).toBe("idle");
  });

  it("takeover intervals pair start with end or stay open", () => {
    const iv = takeoverIntervals(
      [
        { t: iso(T0), label: "takeover_start", text: null },
        { t: iso(T0 + 10_000), label: "takeover_end", text: null },
        { t: iso(T0 + 20_000), label: "takeover_start", text: null },
      ],
      T0 + 30_000,
    );
    expect(iv).toEqual([
      { from: T0, to: T0 + 10_000, open: false },
      { from: T0 + 20_000, to: T0 + 30_000, open: true },
    ]);
  });
});
