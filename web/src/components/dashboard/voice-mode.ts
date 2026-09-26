"use client";

// Which voice pipeline the server runs (StatusOut.voice_mode): "stub" results are canned or operator-chosen and
// every screen that shows one badges it "Simulated voice result" (§8 C2 stub honesty). Fetched once per page load.
import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import type { StatusOut } from "@/lib/contracts";

export type VoiceMode = StatusOut["voice_mode"];

let known: VoiceMode | undefined;
let inflight: Promise<VoiceMode | undefined> | null = null;

function load(): Promise<VoiceMode | undefined> {
  inflight ??= api
    .status()
    .then((s) => (known = s.voice_mode ?? null))
    .catch(() => undefined) // offline: unknown, retried on the next mount
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** "stub" | "real" | null (unknown / older server). Mock mode is always "stub". */
export function useVoiceMode(mock: boolean): VoiceMode {
  const [mode, setMode] = useState<VoiceMode>(mock ? "stub" : (known ?? null));
  useEffect(() => {
    if (mock) {
      setMode("stub");
      return;
    }
    if (known !== undefined) {
      setMode(known);
      return;
    }
    let alive = true;
    void load().then((m) => {
      if (alive && m !== undefined) setMode(m);
    });
    return () => {
      alive = false;
    };
  }, [mock]);
  return mode;
}

/** Test hook: forget the cached mode. */
export function resetVoiceModeCache() {
  known = undefined;
  inflight = null;
}
