"use client";

// Browser co-presence beacon (§5.3, P0): counts of key / pointer / wheel events per second, never content, posted
// every 2 s so the server can tell the owner's own browser (co-present with the laptop's live input → frictionless
// $2,000 purchase, §13 0:20) from a stolen cookie elsewhere (remote → 0.30). Mounted once in the root layout for
// signed-in non-admin users on every page except /overlay (the overlay window captures no input). The observer
// (admin) never anchors a device, so it never beacons. Codex 1's startPresence() is ref-counted, so /enroll's own
// mount shares the same listeners.
import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { useMockMode } from "@/lib/mode";
import { useMe } from "@/lib/session";
import { startPresence } from "@/sdk/presence";

/** Pure: should this page beacon presence? */
export function presenceWanted(opts: { status: string; role: string | null | undefined; pathname: string | null; mock: boolean }): boolean {
  if (opts.mock || opts.status !== "ok") return false;
  if (opts.role === "admin") return false;
  const p = opts.pathname ?? "";
  return !(p === "/overlay" || p.startsWith("/overlay/"));
}

export function PresenceMount() {
  const me = useMe();
  const pathname = usePathname();
  const mock = useMockMode();
  const on = presenceWanted({ status: me.status, role: me.me?.role, pathname, mock });
  useEffect(() => (on ? startPresence() : undefined), [on]);
  return null;
}
