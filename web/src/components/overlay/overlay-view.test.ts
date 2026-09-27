// @vitest-environment jsdom
// Render test: the production /overlay?mock=1 page (the offline fallback) mounts without the conditional-hook
// crash, walks the simulated takeover pill → prompt → lock without a transient pill, and the pill expands into
// "My behavior". Uses the in-browser mock stream with fake timers (no network, no socket).
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OverlayMode } from "./bridge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
let modes: OverlayMode[];
let act: typeof import("react").act;

beforeEach(() => {
  vi.resetModules(); // fresh module singletons (session, mock live store) per test
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-27T14:00:00Z"));
  window.history.replaceState({}, "", "/overlay?mock=1");
  window.localStorage.clear();
  window.sessionStorage.clear();
  modes = [];
  window.twobmeOverlay = { setMode: (m) => void modes.push(m), version: "test", hardLock: false };
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host.remove();
  delete window.twobmeOverlay;
  vi.useRealTimers();
});

async function mount() {
  // react is imported after resetModules too, so the component and the renderer share one React instance
  const [react, { createRoot }, { OverlayView }, { TooltipProvider }] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    import("./overlay-view"),
    import("@/components/ui/tooltip"),
  ]);
  act = react.act;
  const { createElement } = react;
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(TooltipProvider, null, createElement(OverlayView)));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700); // mock snapshot + first tick
  });
}

const mode = () => host.querySelector("[data-overlay-mode]")?.getAttribute("data-overlay-mode");

describe("OverlayView (mock mode)", () => {
  it("renders the trust pill and tells the shell", async () => {
    await mount();
    expect(mode()).toBe("pill");
    expect(host.textContent).toMatch(/\d+%/);
    expect(modes.at(-1)).toBe("pill");
  });

  it("the pill expands into My behavior (and × collapses it)", async () => {
    await mount();
    const expand = host.querySelector<HTMLButtonElement>('button[aria-label="Open My behavior"]');
    expect(expand).not.toBeNull();
    await act(async () => expand!.click());
    expect(mode()).toBe("details");
    expect(modes.at(-1)).toBe("details");
    const text = host.textContent ?? "";
    for (const s of ["My behavior", "What counted", "What left this laptop", "Your identity model", "Recent events"]) expect(text).toContain(s);
    expect(text).toContain("one-class ensemble (twobme_ml)");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Collapse to the pill"]')!.click());
    expect(mode()).toBe("pill");
  });

  it("simulated takeover: pill → prompt → lock, never a pill in between", async () => {
    await mount();
    let sawPrompt = false;
    for (let i = 0; i < 60 && mode() !== "lock"; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      if (mode() === "prompt") sawPrompt = true;
    }
    expect(sawPrompt).toBe(true);
    expect(mode()).toBe("lock");
    expect(host.textContent).toContain("is locked");
    expect(host.textContent).toContain("Simulated voice result");
    const iPrompt = modes.indexOf("prompt");
    const iLock = modes.indexOf("lock");
    expect(iPrompt).toBeGreaterThanOrEqual(0);
    expect(iLock).toBeGreaterThan(iPrompt);
    expect(modes.slice(iPrompt, iLock)).not.toContain("pill");
    // the lock is remembered with its reason (fails closed across a restart), under the mock-only key
    expect(JSON.parse(window.localStorage.getItem("2bme:overlay:locked:mock") ?? "null")).toMatchObject({ reason: "voice_spoof" });
    expect(window.localStorage.getItem("2bme:overlay:locked")).toBeNull();
  }, 20_000);

  it("server event order (terminal challenge, then voice_result, then lock) never flashes the pill", async () => {
    await mount();
    const { getLiveStore } = await import("@/lib/live");
    const { MOCK_DEVICE_ID } = await import("@/lib/live-mock");
    const store = getLiveStore(true);
    const t = () => new Date().toISOString();
    const ch = { challenge_id: "srv-1", trigger: "proactive" as const, status: "issued" as const, attempt: 1, expires_at: null, verify_url: null };
    await act(async () => store.dispatch({ type: "challenge", device_id: MOCK_DEVICE_ID, t: t(), data: ch }));
    expect(mode()).toBe("prompt");
    const from = modes.length;
    // 1. the challenge turns terminal first (open_challenge → null)
    await act(async () => store.dispatch({ type: "challenge", device_id: MOCK_DEVICE_ID, t: t(), data: { ...ch, status: "blocked_spoof" } }));
    expect(mode()).toBe("prompt"); // held full screen, outcome unknown
    // 2. then the voice result
    await act(async () =>
      store.dispatch({
        type: "voice_result",
        device_id: MOCK_DEVICE_ID,
        t: t(),
        data: {
          challenge_id: "srv-1", decision: "BLOCK_SPOOF", voice_confidence: 0.31, asv_cos: 0.58, cm_p_spoof: 0.93, spec_sim: 0.61,
          phrase_wer: 0, onset_ms: 610, dsp: {}, findings: [], stage_ms: {}, simulated: true,
        },
      }),
    );
    expect(mode()).toBe("lock");
    expect(JSON.parse(window.localStorage.getItem("2bme:overlay:locked:mock") ?? "null")).toMatchObject({ reason: "voice_spoof" });
    // 3. then the lock event
    await act(async () => store.dispatch({ type: "lock", device_id: MOCK_DEVICE_ID, t: t(), data: { reason: "voice_spoof" } }));
    expect(mode()).toBe("lock");
    // stub voice: the canned result is never stated as a live finding
    expect(host.textContent).toContain("Simulated voice result");
    expect(host.textContent).toContain("synthetic-voice (spoof) result");
    expect(modes.slice(from)).not.toContain("pill");
  });

});

// ---------------------------------------------------------------------------------------------------------
// Real mode: stubbed fetch + a scripted /ws/live socket (FakeWS), so the tests drive the server's event order.

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.all.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  /** server side */
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  push(type: string, data: unknown, device_id: string | null = DEV_A) {
    if (this.readyState !== 1) return;
    this.onmessage?.({ data: JSON.stringify({ type, data, device_id, t: new Date().toISOString() }) } as MessageEvent);
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

const DEV_A = "dev-a";
const DEV_B = "dev-b";
const LOCK_KEY = "2bme:overlay:locked";
const device = (id: string, label: string, locked = false, lock_reason: string | null = null) => ({
  id, label, pointer: null, mode: "monitor", locked, lock_reason, last_seen: null,
});
const A_MAC = device(DEV_A, "A's MacBook Pro");
const B_PAD = device(DEV_B, "B's ThinkPad");
const meOut = (user: "a" | "b" | "admin", dev: ReturnType<typeof device> | null) => ({
  user_id: `u-${user}`, email: `${user}@2bme.tech`, handle: user, role: user === "admin" ? "admin" : "user", totp_enrolled: true, device: dev,
});
const snapshot = (dev: ReturnType<typeof device> | null, over: Record<string, unknown> = {}) => ({
  device: dev, session_id: "s1", label: "genuine", actor: "a",
  trust: { t: Date.now() / 1000, confidence: 0.97, display: 97, level: "normal", seq: 1, locked: dev?.locked ?? false, contributions: {}, arming: 0 },
  trust_history: [], markers: [], model: null, enroll: null, open_challenge: null, recent_events: [], last_tick_json: null,
  health: null, enrolled_psd: null, recent_blocks: [], ...over,
});
const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const memo = () => JSON.parse(window.localStorage.getItem(LOCK_KEY) ?? "null") as Record<string, unknown> | null;
const sock = () => FakeWS.all.at(-1)!;

describe("OverlayView (real mode): the lock fails closed", () => {
  type Route = (url: string, method: string) => Promise<Response> | null;
  let route: Route;

  async function mountReal(r: Route, remembered?: Record<string, unknown>) {
    route = r;
    FakeWS.all = [];
    window.history.replaceState({}, "", "/overlay");
    vi.stubGlobal("WebSocket", FakeWS);
    vi.stubGlobal(
      "fetch",
      vi.fn((u: RequestInfo | URL, init?: RequestInit) => route(String(u), (init?.method ?? "GET").toUpperCase()) ?? json(404, { detail: "nope" })),
    );
    if (remembered) window.localStorage.setItem(LOCK_KEY, JSON.stringify(remembered));
    const [react, { createRoot }, { OverlayView }, { TooltipProvider }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./overlay-view"),
      import("@/components/ui/tooltip"),
    ]);
    act = react.act;
    await act(async () => {
      root = createRoot(host);
      root.render(react.createElement(TooltipProvider, null, react.createElement(OverlayView)));
    });
    await settle();
  }
  const settle = (ms = 50) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const server = async (fn: () => void) => {
    await act(async () => fn());
    await settle();
  };
  const signedInAs = (user: "a" | "b" | "admin", dev: ReturnType<typeof device> | null, extra?: Route): Route => (u, m) =>
    extra?.(u, m) ?? (u.endsWith("/api/me") ? json(200, meOut(user, dev)) : u.endsWith("/api/status") ? json(200, { voice_mode: null }) : null);
  const A_LOCK = { reason: "voice_spoof", label: "A's MacBook Pro", device_id: DEV_A, simulated: false };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restarted and signed out (session revoked) with a remembered lock → lock screen with its reason, sign-in to unlock", async () => {
    await mountReal((u) => (u.includes("/api/me") ? json(401, { detail: "login required" }) : null), { reason: "voice_impostor", label: "A's MacBook Pro" });
    expect(mode()).toBe("lock");
    expect(modes).not.toContain("pill");
    const text = host.textContent ?? "";
    expect(text).toContain("A's MacBook Pro is locked");
    expect(text).toContain("didn't match the owner");
    expect(text).toContain("Sign in as the owner");
  });

  it("offline with a remembered lock → lock screen that says the network being down never opens it", async () => {
    await mountReal(() => Promise.reject(new TypeError("fetch failed")), A_LOCK);
    expect(mode()).toBe("lock");
    expect(modes).not.toContain("pill");
    expect(host.textContent).toContain("Can't reach 2bME");
  });

  it("b@ signed in: B's own unlocked device never releases A's remembered lock", async () => {
    await mountReal(signedInAs("b", B_PAD), A_LOCK);
    await server(() => sock().open());
    expect(host.textContent).toContain("Checking the lock"); // signed in, no snapshot on this connection yet
    await server(() => sock().push("snapshot", snapshot(B_PAD), DEV_B));
    expect(mode()).toBe("lock");
    expect(modes).not.toContain("pill");
    const text = host.textContent ?? "";
    expect(text).toContain("A's MacBook Pro is locked");
    expect(text).toContain("Signed in as b@2bme.tech");
    expect(text).toContain("Only the owner of A's MacBook Pro can unlock it");
    expect(text).not.toContain("Unlock with voice");
    expect(memo()).toMatchObject({ device_id: DEV_A, reason: "voice_spoof" });
  });

  it("an admin's socket bound to the locked device still can't release it", async () => {
    await mountReal(signedInAs("admin", null), A_LOCK);
    await server(() => sock().open());
    await server(() => sock().push("snapshot", snapshot(A_MAC)));
    expect(mode()).toBe("lock");
    expect(host.textContent).toContain("Signed in as admin@2bme.tech");
    expect(memo()).toMatchObject({ device_id: DEV_A });
  });

  it("the owner's fresh snapshot of the locked device saying unlocked releases it", async () => {
    await mountReal(signedInAs("a", A_MAC), A_LOCK);
    await server(() => sock().open());
    expect(mode()).toBe("lock"); // connected, no snapshot yet: not authoritative
    await server(() => sock().push("snapshot", snapshot(A_MAC)));
    expect(mode()).toBe("pill");
    expect(memo()).toBeNull();
  });

  it("409 from the unlock request never clears the lock by itself: the next snapshot decides", async () => {
    const lockedA = device(DEV_A, "A's MacBook Pro", true, "voice_spoof");
    await mountReal(
      signedInAs("a", lockedA, (u, m) => (u.endsWith("/api/voice/challenges") && m === "POST" ? json(409, { detail: "device is not locked" }) : null)),
      A_LOCK,
    );
    await server(() => sock().open());
    await server(() => sock().push("snapshot", snapshot(lockedA)));
    const unlock = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Unlock with voice"));
    expect(unlock).toBeDefined();
    const sockets = FakeWS.all.length;
    await act(async () => unlock!.click());
    await settle();
    expect(mode()).toBe("lock");
    expect(memo()).toMatchObject({ device_id: DEV_A });
    expect(FakeWS.all.length).toBe(sockets + 1); // re-checking on a fresh connection
    expect(host.textContent).toContain("Re-checking the lock");
    await server(() => sock().open());
    await server(() => sock().push("snapshot", snapshot(lockedA)));
    expect(mode()).toBe("lock");
    expect(memo()).toMatchObject({ device_id: DEV_A });
    await server(() => sock().push("unlock", { reason: "voice_verified" }));
    expect(mode()).toBe("pill");
    expect(memo()).toBeNull();
  });

  it("BLOCK in-page, then the socket drops before the lock event: a reconnect's leftover state never opens it; stub badge without voice_mode", async () => {
    let meUser: "a" | "b" | null = "a";
    await mountReal((u) =>
      u.endsWith("/api/me")
        ? meUser
          ? json(200, meOut(meUser, meUser === "a" ? A_MAC : B_PAD))
          : json(401, { detail: "login required" })
        : u.endsWith("/api/status")
          ? json(200, { voice_mode: null }) // an older server: no voice_mode, only VoiceResultLive.simulated
          : null,
    );
    await server(() => sock().open());
    await server(() => sock().push("snapshot", snapshot(A_MAC)));
    expect(mode()).toBe("pill");
    const ch = { challenge_id: "c-1", trigger: "proactive", status: "issued", attempt: 1, expires_at: null, verify_url: null };
    await server(() => sock().push("challenge", ch));
    expect(mode()).toBe("prompt");
    await server(() => sock().push("challenge", { ...ch, status: "blocked_spoof" }));
    await server(() =>
      sock().push("voice_result", {
        challenge_id: "c-1", decision: "BLOCK_SPOOF", voice_confidence: 0.31, asv_cos: 0.58, cm_p_spoof: 0.93, spec_sim: 0.61,
        phrase_wer: 0, onset_ms: 610, dsp: {}, findings: [], stage_ms: {}, simulated: true,
      }),
    );
    expect(mode()).toBe("lock");
    expect(memo()).toMatchObject({ reason: "voice_spoof", device_id: DEV_A, simulated: true });
    expect(host.textContent).toContain("Simulated voice result");
    // the network drops before the lock event: the store still holds A's device as unlocked
    const first = sock();
    await server(() => first.drop(1006));
    await settle(600); // reconnect backoff
    expect(FakeWS.all.length).toBeGreaterThan(1);
    await server(() => sock().open()); // accepted… (a revoked session is then closed with 4401)
    expect(mode()).toBe("lock");
    expect(memo()).not.toBeNull();
    meUser = null;
    await server(() => sock().drop(4401));
    await settle(100);
    expect(mode()).toBe("lock");
    const i = modes.indexOf("lock");
    expect(modes.slice(i)).not.toContain("pill");
    const text = host.textContent ?? "";
    expect(text).toContain("Sign in as the owner");
    expect(text).toContain("Simulated voice result"); // remembered with the lock, though /api/status says nothing
    expect(text).toContain("synthetic-voice (spoof) result");
    expect(text).not.toContain("A synthetic (cloned) voice answered");

    // b@ signs in on A's lock screen: the stream drops A's device and binds afresh; B's device never unlocks A's
    meUser = "b";
    const { refreshMe } = await import("@/lib/session");
    const before = FakeWS.all.length;
    await act(async () => {
      await refreshMe();
    });
    await settle();
    expect(FakeWS.all.length).toBeGreaterThan(before);
    expect(sock().url).not.toContain("device_id="); // not pinned to A's device any more
    await server(() => sock().open());
    await server(() => sock().push("snapshot", snapshot(B_PAD), DEV_B));
    expect(mode()).toBe("lock");
    expect(host.textContent).toContain("Signed in as b@2bme.tech");
    expect(memo()).toMatchObject({ device_id: DEV_A });
    expect(modes.slice(i)).not.toContain("pill");
  });
});

describe("parseLockMemory", () => {
  it("fails closed on anything it can't read", async () => {
    const { parseLockMemory } = await import("./overlay-view");
    const none = { reason: null, label: null, device_id: null, simulated: false };
    expect(parseLockMemory(null)).toBeNull();
    expect(parseLockMemory("1")).toEqual(none);
    expect(parseLockMemory("{oops")).toEqual(none);
    expect(parseLockMemory(JSON.stringify({ reason: "voice_spoof", label: 3 }))).toEqual({ ...none, reason: "voice_spoof" });
    expect(parseLockMemory(JSON.stringify({ reason: "voice_spoof", label: "A", device_id: "d", simulated: true }))).toEqual({
      reason: "voice_spoof", label: "A", device_id: "d", simulated: true,
    });
  });
});
