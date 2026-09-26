"use client";

import { useEffect } from "react";

/** Marks <html> so the site nav/footer hide and the page background is transparent (see globals.css). */
export function OverlayChrome({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const el = document.documentElement;
    el.classList.add("overlay-mode");
    return () => el.classList.remove("overlay-mode");
  }, []);
  return <>{children}</>;
}
