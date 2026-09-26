// Who is signed in (GET /api/me), shared by every component through one module-level store.
import { useSyncExternalStore } from "react";

import { ApiError, api } from "./api";
import type { MeOut } from "./contracts";
import { isMockMode } from "./mode";

export type MeStatus = "loading" | "ok" | "anon" | "offline";

export interface MeState {
  status: MeStatus;
  me: MeOut | null;
  mock: boolean;
}

const MOCK_ME: MeOut = {
  user_id: "mock-user-a",
  email: "a@2bme.tech",
  handle: "a (mock)",
  role: "admin",
  totp_enrolled: true,
  device: null,
};

const INITIAL: MeState = { status: "loading", me: null, mock: false };
let state: MeState = INITIAL;
let inflight: Promise<void> | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function set(next: MeState) {
  state = next;
  for (const l of listeners) l();
}

export function refreshMe(): Promise<void> {
  if (isMockMode()) {
    set({ status: "ok", me: MOCK_ME, mock: true });
    return Promise.resolve();
  }
  inflight ??= api
    .me()
    .then((me) => set({ status: "ok", me, mock: false }))
    .catch((e: unknown) => {
      const offline = e instanceof ApiError && (e.offline || e.status >= 500);
      set({ status: offline ? "offline" : "anon", me: null, mock: false });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function clearMe() {
  set({ status: "anon", me: null, mock: false });
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (!loaded) {
    loaded = true;
    void refreshMe();
  }
  return () => listeners.delete(l);
}

export function useMe(): MeState {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}
