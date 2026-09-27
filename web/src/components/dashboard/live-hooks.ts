"use client";

// Small /ws/live lifecycle fixes shared by the dashboard and the overlay (§6 A6 hardening):
//  - the stream connected before this user's device existed → re-bind (resnapshot) once the device shows up;
//  - the server closed the stream with 4401 (session revoked by a BLOCK_*) → re-check who is signed in.
// Plus the admin drill-in (/dashboard?device_id=): which roster row the page is showing.
import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import type { RosterRow } from "@/lib/contracts";
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

/** An admin viewing someone's device from the org console (/dashboard?device_id=): its roster row, once loaded. */
export interface Drill {
  deviceId: string;
  /** null until the roster loads (or when the device isn't on it) */
  row: RosterRow | null;
  /** the roster loaded and has no such device */
  notFound: boolean;
}

const DRILL_POLL_MS = 15_000;

/** Roster row for the drilled-in device (admin only), re-read every 15 s so online/offline stays current. */
export function useDrill(deviceId: string | null): Drill | null {
  const [state, setState] = useState<{ id: string; row: RosterRow | null; notFound: boolean } | null>(null);
  useEffect(() => {
    if (!deviceId) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const rows = await api.adminRoster(ctl.signal);
        const row = rows.find((r) => r.device_id === deviceId) ?? null;
        setState({ id: deviceId, row, notFound: row === null });
      } catch {
        /* keep the last answer; a failed poll never claims "not found" */
      }
      if (!ctl.signal.aborted) timer = setTimeout(load, DRILL_POLL_MS);
    };
    void load();
    return () => {
      ctl.abort();
      clearTimeout(timer);
    };
  }, [deviceId]);
  if (!deviceId) return null;
  const cur = state?.id === deviceId ? state : null;
  return { deviceId, row: cur?.row ?? null, notFound: cur?.notFound ?? false };
}

/** Seconds since the agent's last heartbeat, advanced by the time since that health report arrived. */
export function heartbeatAge(s: Pick<LiveState, "health" | "healthAt">, now: number): number | null {
  const hb = s.health?.heartbeat_age_s;
  if (hb === null || hb === undefined) return null;
  return hb + (s.healthAt ? Math.max(0, (now - s.healthAt) / 1000) : 0);
}

/** The agent stopped reporting: live heartbeat ≥ 30 s, else (no health yet) the roster's online flag. */
export function agentOffline(s: Pick<LiveState, "health" | "healthAt">, drill: Drill | null, now: number): boolean {
  const hb = heartbeatAge(s, now);
  if (hb !== null) return hb >= 30;
  return drill?.row?.online === false;
}
