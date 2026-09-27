"use client";

// Small /ws/live lifecycle fixes shared by the dashboard and the overlay (§6 A6 hardening):
//  - the stream connected before this user's device existed → re-bind (resnapshot) once the device shows up;
//  - the server closed the stream with 4401 (session revoked by a BLOCK_*) → re-check who is signed in.
import { useEffect, useRef } from "react";

import type { LiveState, LiveStore } from "@/lib/live";
import { refreshMe } from "@/lib/session";

/**
 * The server binds a /ws/live socket to a device when it opens. If it opened before the device existed, the
 * snapshot had device=null and the socket stays unbound: trust events still flow, but lock state, the model and
 * the open challenge never arrive (the overlay sat at "1% reconnecting"). Once events name a device, reconnect.
 */
export function needsResnapshot(s: Pick<LiveState, "connected" | "synced" | "device" | "knownDevices">, mock: boolean): string | null {
  // only once this connection's own snapshot said "no device" (not while it is still on its way)
  if (mock || !s.connected || !s.synced || s.device !== null) return null;
  const ids = Object.keys(s.knownDevices).sort();
  return ids.length ? ids.join(",") : null;
}

export function useResnapshotOnFirstDevice(state: LiveState, store: LiveStore | null, mock: boolean) {
  const key = needsResnapshot(state, mock);
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!key || !store || done.current === key) return;
    done.current = key; // once per set of devices: never loops if the server still can't bind
    store.reconnect();
  }, [key, store]);
}

/** 4401 = the server refused or revoked this browser session: refresh /me so the page shows the signed-out state. */
export function useRefreshMeOnAuthClose(closeCode: number | null, mock: boolean) {
  useEffect(() => {
    if (!mock && closeCode === 4401) void refreshMe();
  }, [closeCode, mock]);
}
