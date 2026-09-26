// STUB (A0) — owner: Codex 2
"use client";

import { AudioLines, Loader2, Lock, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { EmptyState, PageHeader } from "@/components/site/empty-state";
import { Button } from "@/components/ui/button";
import { mockBackend, realBackend } from "@/components/verify-stub/backend";
import { ChallengeFlow } from "@/components/verify-stub/challenge-flow";
import { ApiError } from "@/lib/api";
import { useLive } from "@/lib/live";
import { useMockMode } from "@/lib/mode";
import { useMe } from "@/lib/session";

function NoChallenge({ mock }: { mock: boolean }) {
  const router = useRouter();
  const me = useMe();
  const { state } = useLive({ enabled: me.status === "ok" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backend = mock ? mockBackend : realBackend;
  const locked = Boolean(state.device?.locked || me.me?.device?.locked);
  const open = state.open_challenge;

  async function unlock() {
    setBusy(true);
    setError(null);
    try {
      const ch = await backend.createUnlock();
      router.replace(`/verify?c=${encodeURIComponent(ch.challenge_id)}`);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.status === 409
            ? "This device isn't locked."
            : e.status === 403
              ? "Log in again: unlocking needs a session created after the lock."
              : e.status === 429
                ? "Too many unlock attempts. Wait 10 minutes."
                : e.detail
          : String(e),
      );
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <EmptyState
        icon={locked ? Lock : ShieldCheck}
        title={locked ? "This device is locked" : "No voice check is waiting"}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {(locked || mock) && (
              <Button onClick={() => void unlock()} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <AudioLines />} Unlock with voice
              </Button>
            )}
            {open && (
              <Button asChild variant="outline">
                <Link href={`/verify?c=${encodeURIComponent(open.challenge_id)}`}>Open the pending challenge</Link>
              </Button>
            )}
            {me.status === "anon" && (
              <Button asChild variant="outline">
                <Link href="/login">Log in</Link>
              </Button>
            )}
          </div>
        }
      >
        {locked
          ? "A failed voice check locked it. The owner can unlock it with a fresh phrase."
          : "Challenges open here from the dashboard banner, a stepped-up checkout, or the agent's notification (/verify?c=…)."}
        {error && <span className="mt-2 block text-destructive">{error}</span>}
      </EmptyState>
    </div>
  );
}

function VerifyBody() {
  const params = useSearchParams();
  const mock = useMockMode();
  const c = params.get("c");
  const d = params.get("d");
  const dev = params.get("dev") === "1" || mock || process.env.NODE_ENV === "development";
  if (!c) return <NoChallenge mock={mock} />;
  return <ChallengeFlow key={c} challengeId={c} decisionId={d} backend={mock ? mockBackend : realBackend} devControls={dev} />;
}

export default function VerifyPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <PageHeader eyebrow="Step-up" title="Voice check">
        Listen to the prompt, then read the phrase back. We check the words, the speaker and the spectrum, and an anti-spoof model
        checks whether the voice is synthetic. Audio is deleted after scoring.
      </PageHeader>
      <Suspense fallback={<div className="panel h-64 animate-pulse" />}>
        <VerifyBody />
      </Suspense>
    </div>
  );
}
