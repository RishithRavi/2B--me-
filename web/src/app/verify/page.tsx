"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { PageHeader } from "@/components/site/empty-state";
import { Button } from "@/components/ui/button";
import { ChallengeFlow } from "@/components/voice/challenge-flow";
import { VoiceEnroll } from "@/components/voice/voice-enroll";
import { api, errorMessage } from "@/lib/api";

function VerifyBody() {
  const params = useSearchParams();
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const challengeId = created ?? params.get("c");
  async function unlock() {
    setBusy(true); setError("");
    try { setCreated((await api.createChallenge("unlock")).challenge_id); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-6">
    <section className="panel p-6">
      {challengeId ? <ChallengeFlow key={challengeId} challengeId={challengeId} /> : <div className="space-y-3">
        <p className="text-sm">Open a challenge link, or sign in again after a lock to request an unlock.</p>
        <Button disabled={busy} onClick={() => void unlock()}>{busy ? "Requesting…" : "Request unlock challenge"}</Button>
        <Link href="/login" className="ml-4 text-sm underline">Sign in</Link>
      </div>}
      {error && <p role="alert" className="mt-3 text-sm text-red-500">{error}</p>}
    </section>
    {!challengeId && <section className="panel p-6"><VoiceEnroll /></section>}
  </div>;
}
export default function VerifyPage() {
  return <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
    <PageHeader eyebrow="Step-up" title="Voice check">Listen, then read the five words. We check the phrase, speaker and signs of synthetic speech.</PageHeader>
    <Suspense fallback={<div className="panel h-48 animate-pulse" />}><VerifyBody /></Suspense>
    <p className="mt-6 text-xs text-muted-foreground">Challenge audio is processed by our server and deleted after scoring. <Link href="/#privacy" className="underline">Voice privacy details</Link></p>
  </div>;
}
