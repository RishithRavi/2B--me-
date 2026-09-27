"use client";

// What the server actually runs, from GET /api/status (fetched once per page load; while it can't be read it is
// retried with backoff, and right away whenever the caller's `retryKey` changes, e.g. sign-in or the live socket
// connecting: the overlay is a long-lived page that may start before the API is reachable):
//  - voice_mode: "stub" results are canned or operator-chosen, and every screen that shows one badges it
//    "Simulated voice result" (§8 C2 stub honesty);
//  - the behavior scorer (StatusOut.model_backend, else inference.model_backend): the identity card's fallback when
//    ModelInfo.backend isn't filled in by the server yet.
import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import type { StatusOut } from "@/lib/contracts";

export type VoiceMode = StatusOut["voice_mode"];

export interface ServerInfo {
  voiceMode: VoiceMode;
  modelBackend: string | null;
}

const UNKNOWN: ServerInfo = { voiceMode: null, modelBackend: null };
const MOCK: ServerInfo = { voiceMode: "stub", modelBackend: "twobme_ml" };

let known: ServerInfo | undefined;
let inflight: Promise<ServerInfo | undefined> | null = null;

/** Pure: StatusOut → ServerInfo. */
export function serverInfoFrom(s: StatusOut): ServerInfo {
  const inf = s.inference?.model_backend;
  return { voiceMode: s.voice_mode ?? null, modelBackend: s.model_backend ?? (typeof inf === "string" ? inf : null) };
}

function load(): Promise<ServerInfo | undefined> {
  inflight ??= api
    .status()
    .then((s) => (known = serverInfoFrom(s)))
    .catch(() => undefined) // offline: unknown, retried (useServerInfo)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export const RETRY_MIN_MS = 2000;
export const RETRY_MAX_MS = 30_000;

/**
 * `retryKey`: while the status is still unknown, a change (e.g. `${me.status}:${connected}`) retries right away
 * instead of waiting for the backoff.
 */
export function useServerInfo(mock: boolean, retryKey?: string | number | boolean | null): ServerInfo {
  const [info, setInfo] = useState<ServerInfo>(mock ? MOCK : (known ?? UNKNOWN));
  useEffect(() => {
    if (mock) {
      setInfo(MOCK);
      return;
    }
    if (known !== undefined) {
      setInfo(known);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = RETRY_MIN_MS;
    const attempt = () => {
      timer = null;
      void load().then((i) => {
        if (!alive) return;
        if (i !== undefined) {
          setInfo(i);
          return;
        }
        timer = setTimeout(attempt, delay);
        delay = Math.min(RETRY_MAX_MS, delay * 2);
      });
    };
    attempt();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [mock, retryKey]);
  return info;
}

/** "stub" | "real" | null (unknown / older server). Mock mode is always "stub". */
export function useVoiceMode(mock: boolean, retryKey?: string | number | boolean | null): VoiceMode {
  return useServerInfo(mock, retryKey).voiceMode;
}

/** Test hook: forget the cached status. */
export function resetServerInfoCache() {
  known = undefined;
  inflight = null;
}
