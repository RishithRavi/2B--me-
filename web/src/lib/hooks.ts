"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/** Current time in ms, re-rendering every `intervalMs` (0 = frozen). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!intervalMs) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const noopSubscribe = () => () => {};

/** false during prerender/hydration, true after — for anything that depends on the client clock or window size. */
export function useMounted(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}
