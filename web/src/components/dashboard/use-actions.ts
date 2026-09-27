"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "@/lib/api";
import type { Mode } from "@/lib/contracts";
import type { LiveStore } from "@/lib/live";

export type ActionName = "mode" | "train" | "retrain" | "takeover" | "reset" | "rearm" | "unlock";

/**
 * Operator actions for the dashboard. Real mode → REST (contracts/api.md); mock mode → the in-browser simulator.
 * Every action toasts its outcome; `busy` names the action in flight.
 * `voiceStub`: the server runs stub voice, so Reset also clears the operator's simulated voice outcome (the server
 * keeps it until cleared, and a leftover BLOCK_* would also decide the owner's unlock).
 */
export function useDashboardActions(store: LiveStore | null, deviceId: string | null, opts: { voiceStub?: boolean } = {}) {
  const voiceStub = !!opts.voiceStub;
  const router = useRouter();
  const [busy, setBusy] = useState<ActionName | null>(null);
  const mock = store?.mock ?? null;

  const run = useCallback(
    async (name: ActionName, fn: () => Promise<unknown> | unknown, ok?: string) => {
      if (!mock && !deviceId && name !== "unlock") {
        toast.error("No device yet — start the agent first");
        return;
      }
      setBusy(name);
      try {
        await fn();
        if (ok) toast.success(ok);
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [mock, deviceId],
  );

  const id = deviceId ?? "";

  return {
    busy,
    setMode: (mode: Mode) =>
      run("mode", () => (mock ? mock.setMode(mode) : api.setMode(id, mode)), mode === "enroll" ? "Enroll mode: collecting your baseline" : "Monitor mode: scoring live"),
    train: () => run("train", () => (mock ? mock.train() : api.train(id, "tiger")), "Training started — the identity card updates when it's ready"),
    retrain: () => run("retrain", () => (mock ? mock.train() : api.retrain(id)), "Retraining now"),
    setTakeover: (on: boolean) =>
      run(
        "takeover",
        async () => {
          if (mock) return mock.setTakeover(on);
          await api.demoLabel({ device_id: id, label: on ? "impostor" : "genuine", actor: on ? "b" : "a" });
          await api.demoMarker({ device_id: id, label: on ? "takeover_start" : "takeover_end" });
        },
        on ? "Takeover marked — B is at the keyboard (ground truth only)" : "Takeover ended — A is back",
      ),
    reset: () =>
      run(
        "reset",
        async () => {
          if (mock) return mock.reset();
          await api.demoReset(id);
          if (voiceStub) await api.demoVoiceOutcome(id, null).catch(() => undefined); // best effort (older server: 404)
        },
        voiceStub && !mock ? "Demo reset — new session at 97%, simulated voice outcome back to Auto" : "Demo reset — new session at 97%",
      ),
    rearm: () => run("rearm", () => (mock ? mock.rearm(0.31) : api.demoRearm(id, 0.31)), "Re-armed at 31%"),
    unlockWithVoice: () =>
      run("unlock", async () => {
        if (mock) {
          mock.unlock();
          toast.message("Simulated voice unlock in progress…");
          return;
        }
        const ch = await api.createChallenge("unlock");
        router.push(`/verify?c=${encodeURIComponent(ch.challenge_id)}`);
      }),
  };
}

export type DashboardActions = ReturnType<typeof useDashboardActions>;
