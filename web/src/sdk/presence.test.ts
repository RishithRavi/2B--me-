// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startPresence } from "./presence";
let handlers: Record<string, EventListener>;
let cleanup: (() => void)[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  handlers = {};
  cleanup = [];
  const original = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(((
    type: string,
    fn: EventListener,
    options: unknown,
  ) => {
    handlers[type] = fn;
    original(type, fn, options as boolean);
  }) as typeof window.addEventListener);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => {
  cleanup.forEach((fn) => fn());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("sends only completed count buckets and shares one listener set", async () => {
  cleanup.push(startPresence(), startPresence());
  handlers.keydown({ isTrusted: true } as Event);
  handlers.pointerdown({ isTrusted: true } as Event);
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [, options] = vi.mocked(fetch).mock.calls[0];
  expect(JSON.parse(options!.body as string)).toEqual({
    buckets: [{ t_s: 1767225600, keys: 1, pointer: 1, wheel: 0 }],
  });
  expect(window.addEventListener).toHaveBeenCalledTimes(3);
});
it("ignores synthetic events and retries failed buckets", async () => {
  cleanup.push(startPresence());
  handlers.keydown({ isTrusted: false } as Event);
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetch).not.toHaveBeenCalled();
  handlers.wheel({ isTrusted: true } as Event);
  vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
  await vi.advanceTimersByTimeAsync(2000);
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetch).toHaveBeenCalledTimes(2);
});
