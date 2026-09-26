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

  it("the pill expands into My behavior (and Escape collapses it)", async () => {
    await mount();
    const expand = host.querySelector<HTMLButtonElement>('button[aria-label="Open My behavior"]');
    expect(expand).not.toBeNull();
    await act(async () => expand!.click());
    expect(mode()).toBe("details");
    expect(modes.at(-1)).toBe("details");
    const text = host.textContent ?? "";
    for (const s of ["My behavior", "What counted", "What left this laptop", "Your identity model", "Recent events"]) expect(text).toContain(s);
    expect(text).toContain("one-class ensemble (twobme_ml)");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
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
    // the lock is remembered (fails closed across a restart), under the mock-only key
    expect(window.localStorage.getItem("2bme:overlay:locked:mock")).toBe("1");
    expect(window.localStorage.getItem("2bme:overlay:locked")).toBeNull();
  }, 20_000);
});
