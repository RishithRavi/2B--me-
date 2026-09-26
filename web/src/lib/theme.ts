// Dark-first theme: <html class="dark"> by default; a stored "light" choice flips it before first paint.
import { useSyncExternalStore } from "react";

import { THEME_KEY as KEY } from "./theme-script";

export type Theme = "dark" | "light";

const listeners = new Set<() => void>();

function current(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function setTheme(t: Theme) {
  const el = document.documentElement;
  el.classList.toggle("dark", t === "dark");
  el.classList.toggle("light", t === "light");
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode */
  }
  for (const l of listeners) l();
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    current,
    () => "dark",
  );
}
