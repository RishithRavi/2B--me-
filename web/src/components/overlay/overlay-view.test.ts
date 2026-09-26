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
    expect(host.textContent).toContain("synthetic (cloned) voice");
    expect(modes.slice(from)).not.toContain("pill");
  });

});

describe("OverlayView (real mode, no live stream): the lock fails closed", () => {
  async function mountReal(fetchImpl: (url: string) => Promise<Response>) {
    window.history.replaceState({}, "", "/overlay");
    vi.stubGlobal("fetch", vi.fn((u: RequestInfo | URL) => fetchImpl(String(u))));
    window.localStorage.setItem("2bme:overlay:locked", JSON.stringify({ reason: "voice_impostor", label: "A's MacBook Pro" }));
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
  }
  const json = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restarted and signed out (session revoked) with a remembered lock → lock screen with its reason, sign-in to unlock", async () => {
    await mountReal((u) => (u.includes("/api/me") ? json(401, { detail: "login required" }) : json(404, { detail: "nope" })));
    expect(mode()).toBe("lock");
    expect(modes).not.toContain("pill");
    const text = host.textContent ?? "";
    expect(text).toContain("A's MacBook Pro is locked");
    expect(text).toContain("didn't match the owner");
    expect(text).toContain("Sign in as the owner");
  });

  it("offline with a remembered lock → lock screen that says the network being down never opens it", async () => {
    await mountReal(() => Promise.reject(new TypeError("fetch failed")));
    expect(mode()).toBe("lock");
    expect(modes).not.toContain("pill");
    expect(host.textContent).toContain("Can't reach 2bME");
  });
});

describe("parseLockMemory", () => {
  it("fails closed on anything it can't read", async () => {
    const { parseLockMemory } = await import("./overlay-view");
    expect(parseLockMemory(null)).toBeNull();
    expect(parseLockMemory("1")).toEqual({ reason: null, label: null });
    expect(parseLockMemory("{oops")).toEqual({ reason: null, label: null });
    expect(parseLockMemory(JSON.stringify({ reason: "voice_spoof", label: 3 }))).toEqual({ reason: "voice_spoof", label: null });
  });
});
