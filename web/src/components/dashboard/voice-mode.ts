"use client";

// What the server actually runs, from GET /api/status (fetched once per page load):
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
    .catch(() => undefined) // offline: unknown, retried on the next mount
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useServerInfo(mock: boolean): ServerInfo {
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
    void load().then((i) => {
      if (alive && i !== undefined) setInfo(i);
    });
    return () => {
      alive = false;
    };
  }, [mock]);
  return info;
}

/** "stub" | "real" | null (unknown / older server). Mock mode is always "stub". */
export function useVoiceMode(mock: boolean): VoiceMode {
  return useServerInfo(mock).voiceMode;
}

/** Test hook: forget the cached status. */
export function resetServerInfoCache() {
  known = undefined;
  inflight = null;
}
