// Mock-mode switch: NEXT_PUBLIC_MOCK=1 at build/dev time, or ?mock=1 in the URL (sticky for the tab via
// sessionStorage; ?mock=0 clears it). Mock mode never opens a socket and never calls the API for live data.
import { useSyncExternalStore } from "react";

const KEY = "2bme:mock";

export function isMockMode(): boolean {
  if (process.env.NEXT_PUBLIC_MOCK === "1") return true;
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search).get("mock");
    if (q === "1") {
      window.sessionStorage.setItem(KEY, "1");
      return true;
    }
    if (q === "0") {
      window.sessionStorage.removeItem(KEY);
      return false;
    }
    return window.sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

const noopSubscribe = () => () => {};

/** Hydration-safe: false during prerender, the real value after hydration. */
export function useMockMode(): boolean {
  return useSyncExternalStore(noopSubscribe, isMockMode, () => false);
}

/** Random id that also works outside secure contexts (crypto.randomUUID needs https/localhost). */
export function randomId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${hex()}-${hex()}${hex()}${hex()}`;
}
