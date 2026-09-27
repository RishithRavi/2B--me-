// @vitest-environment jsdom
// The stage view's "Voice outcome (simulated)" control never claims a server state it didn't set, a manual pick
// covers the next voice check only, and Reset clears it. Plus: /api/status is retried until the voice mode is known.
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MarkerPoint } from "@/lib/contracts";
import type { LiveVoiceResult } from "@/lib/live";

import { pendingSettled, resultKey, type PendingOutcome } from "./voice-outcome-control";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const result = (id: string, t: string): LiveVoiceResult => ({
  challenge_id: id,
  t,
  decision: "BLOCK_SPOOF",
  voice_confidence: 0.3,
  asv_cos: 0.58,
  cm_p_spoof: 0.93,
  spec_sim: 0.6,
  phrase_wer: 0,
  onset_ms: 600,
  dsp: {},
  findings: [],
  stage_ms: {},
  simulated: true,
});
const reset = (t: string): MarkerPoint => ({ t, label: "reset", text: null });

describe("pendingSettled", () => {
  const old = result("c0", "2026-09-27T14:00:00Z");
  const p: PendingOutcome = { decision: "BLOCK_SPOOF", seen: [resultKey(old)], resetAt: Date.parse("2026-09-27T13:00:00Z") };

  it("waits while only results that were already on screen are there", () => {
    expect(pendingSettled(p, [old], [])).toBeNull();
    expect(pendingSettled(p, [], [reset("2026-09-27T13:00:00Z")])).toBeNull();
  });

  it("is used by the next voice result, voided by a newer Reset", () => {
    expect(pendingSettled(p, [result("c1", "2026-09-27T14:01:00Z"), old], [])).toBe("used");
    expect(pendingSettled(p, [old], [reset("2026-09-27T14:02:00Z")])).toBe("reset");
  });

  it("after a reload (nothing on screen), any result that arrives counts", () => {
    expect(pendingSettled(p, [result("c1", "2026-09-27T14:01:00Z")], [])).toBe("used");
  });
});

// ---------------------------------------------------------------------------------------------------------

let root: Root | null = null;
let host: HTMLDivElement;
let act: typeof import("react").act;
let posts: { url: string; body: unknown }[];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  window.sessionStorage.clear();
  posts = [];
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));

describe("VoiceOutcomeControl", () => {
  async function mount(results: LiveVoiceResult[], markers: MarkerPoint[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn((u: RequestInfo | URL, init?: RequestInit) => {
        posts.push({ url: String(u), body: init?.body ? JSON.parse(String(init.body)) : null });
        return ok({ ok: true });
      }),
    );
    const [react, { createRoot }, { VoiceOutcomeControl }, { TooltipProvider }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./voice-outcome-control"),
      import("@/components/ui/tooltip"),
    ]);
    act = react.act;
    const render = (r: LiveVoiceResult[], m: MarkerPoint[]) =>
      act(async () => {
        root ??= createRoot(host);
        root.render(
          react.createElement(
            TooltipProvider,
            null,
            react.createElement(VoiceOutcomeControl, { deviceId: "dev-a", mock: false, voiceResults: r, markers: m }),
          ),
        );
      });
    await render(results, markers);
    return render;
  }
  const checked = () => [...host.querySelectorAll('[role="radio"][aria-checked="true"]')].map((b) => b.textContent?.replace("· next", "").trim());
  const click = (label: string) =>
    act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent?.startsWith(label))!.click();
      await vi.advanceTimersByTimeAsync(10);
    });
  const sub = () => host.querySelector('[data-testid="voice-outcome-sub"]')?.textContent ?? "";

  it("opens with nothing selected (it can't read the server's pick), never claiming Auto", async () => {
    await mount([], []);
    expect(checked()).toEqual([]);
    expect(sub()).toContain("not set from this screen");
  });

  it("a BLOCK_SPOOF pick covers the next voice check only, then goes back to Auto on the server", async () => {
    const before = [result("c0", "2026-09-27T14:00:00Z")];
    const render = await mount(before, []);
    await click("BLOCK_SPOOF");
    expect(posts.at(-1)).toMatchObject({ url: "/api/demo/voice-outcome", body: { device_id: "dev-a", decision: "BLOCK_SPOOF" } });
    expect(checked()).toEqual(["BLOCK_SPOOF"]);
    expect(sub()).toContain("next voice check only");
    await render(before, []); // nothing new yet
    expect(posts.length).toBe(1);
    await render([result("c1", "2026-09-27T14:01:00Z"), ...before], []);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(posts.at(-1)).toMatchObject({ url: "/api/demo/voice-outcome", body: { device_id: "dev-a", decision: null } });
    expect(checked()).toEqual(["Auto"]);
    expect(window.sessionStorage.getItem("2bme:stage:voice-outcome:dev-a")).toBeNull();
  });

  it("a reload of the stage view keeps this tab's pending pick; a Reset clears it", async () => {
    window.sessionStorage.setItem(
      "2bme:stage:voice-outcome:dev-a",
      JSON.stringify({ decision: "BLOCK_SPOOF", seen: ["c0@2026-09-27T14:00:00Z"], resetAt: Date.parse("2026-09-27T13:00:00Z") }),
    );
    const render = await mount([], []);
    expect(checked()).toEqual(["BLOCK_SPOOF"]);
    await render([], [reset("2026-09-27T14:05:00Z")]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(posts.at(-1)).toMatchObject({ body: { device_id: "dev-a", decision: null } });
    expect(checked()).toEqual(["Auto"]);
  });
});

describe("useServerInfo", () => {
  it("retries /api/status with backoff until it answers (a long-lived overlay that started offline)", async () => {
    let up = false;
    const fetchMock = vi.fn((u: RequestInfo | URL) =>
      String(u).endsWith("/api/status") && up ? ok({ voice_mode: "stub", model_backend: "twobme_ml" }) : Promise.reject(new TypeError("fetch failed")),
    );
    vi.stubGlobal("fetch", fetchMock);
    const [react, { createRoot }, { useServerInfo }] = await Promise.all([import("react"), import("react-dom/client"), import("./voice-mode")]);
    act = react.act;
    function Probe() {
      const s = useServerInfo(false, "k");
      return react.createElement("span", { "data-voice": String(s.voiceMode) });
    }
    await act(async () => {
      root = createRoot(host);
      root.render(react.createElement(Probe));
    });
    const voice = () => host.querySelector("[data-voice]")?.getAttribute("data-voice");
    expect(voice()).toBe("null");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    const calls = fetchMock.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2);
    up = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    expect(voice()).toBe("stub");
  });
});
