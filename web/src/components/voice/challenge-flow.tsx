"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import type { ChallengeOut, ChallengeResponseOut, VoiceOutcome, VoiceStageLive } from "@/lib/contracts";
import { useLive } from "@/lib/live";
import { VoiceRecorder } from "./voice-recorder";
import { SpectrogramView } from "./spectrogram-view";

const stages = ["transcribing", "anti-spoof", "speaker", "spectral"] as const;
const stageNames = { transcribing: "Words", "anti-spoof": "Anti-spoof", speaker: "Speaker", spectral: "Spectrum" };
const decisionText = { VERIFY: "Voice verified", BLOCK_SPOOF: "Synthetic voice detected",
  BLOCK_IMPOSTOR: "Speaker did not match", RETRY: "Please try a new phrase", FALLBACK_MFA: "Use your authenticator code" };

export function ChallengeFlow({ challengeId, onDone, onMfaDone }: {
  challengeId: string;
  onDone?: (response: ChallengeResponseOut) => void;
  onMfaDone?: (outcome: VoiceOutcome) => void;
}) {
  const [challenge, setChallenge] = useState<ChallengeOut | null>(null);
  const [reply, setReply] = useState<ChallengeResponseOut | null>(null);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaVerified, setMfaVerified] = useState(false);
  const [uploading, setUploading] = useState(false);
  const mounted = useRef(true);
  const previousStages = useRef<VoiceStageLive[]>([]);
  const { state } = useLive({ mock: false });
  useEffect(() => {
    mounted.current = true;
    let current = true;
    setChallenge(null); setReply(null); setError(""); setMfaVerified(false);
    api.challenge(challengeId).then((c) => { if (current) setChallenge(c); })
      .catch((e) => { if (current) setError(errorMessage(e)); });
    return () => { current = false; mounted.current = false; };
  }, [challengeId]);

  async function submit(wav: Blob, offset: number) {
    previousStages.current = state.voiceStages[challengeId] ?? [];
    setUploading(true); setError("");
    try {
      const response = await api.challengeResponse(challengeId, wav, offset);
      if (!mounted.current) return;
      setReply(response);
      if (response.next) setChallenge((c) => c ? { ...c, ...response.next, status: "retry" } : c);
      onDone?.(response);
    } finally { if (mounted.current) setUploading(false); }
  }

  async function verifyMfa() {
    if (mfaBusy) return;
    setMfaBusy(true); setError("");
    try {
      const result = await api.totpVerify(challengeId, code);
      if (!mounted.current) return;
      setCode("");
      if (!result.ok) setError("Authenticator code was not accepted.");
      else { setMfaVerified(true); onMfaDone?.(result.outcome); }
    } catch (e) { if (mounted.current) setError(errorMessage(e)); }
    finally { if (mounted.current) setMfaBusy(false); }
  }

  const terminal = reply && ["VERIFY", "BLOCK_SPOOF", "BLOCK_IMPOSTOR"].includes(reply.result.decision);
  const closed = challenge && ["verified", "blocked_spoof", "blocked_impostor", "expired", "cancelled"].includes(challenge.status);
  const fallback = reply?.result.decision === "FALLBACK_MFA" || challenge?.status === "fallback_mfa";
  const liveStages = (state.voiceStages[challengeId] ?? []).filter((stage) => !previousStages.current.includes(stage));
  return <div className="space-y-5">
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    {!challenge && !error && <p role="status">Loading voice challenge…</p>}
    {challenge && <>
      <p className="text-xs text-muted-foreground">Attempt {challenge.attempt} of 3 · {challenge.trigger.replaceAll("_", " ")}</p>
      {!terminal && !closed && !fallback && !mfaVerified && <VoiceRecorder key={`${challengeId}:${challenge.attempt}`}
        phrase={challenge.phrase} promptUrl={api.promptUrl(challengeId)} disabled={uploading}
        onPromptEnded={() => api.promptEnded(challengeId)} onRecorded={submit} />}
      {uploading && <ol aria-label="Voice analysis stages" className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        {stages.map((stage) => {
          const event = liveStages.find((s) => s.stage === stage);
          return <li key={stage} className="rounded-lg border p-2">{stageNames[stage]} · {event ? event.ok === false ? "Review" : "Done" : "Waiting"}</li>;
        })}
      </ol>}
      {closed && !reply && <p role="status">This challenge is {challenge.status.replaceAll("_", " ")}. Request a new challenge if needed.</p>}
      {reply && <div className="space-y-3 rounded-xl border p-4" role="status">
        <h3 className="font-semibold">{decisionText[reply.result.decision]}</h3>
        <dl className="grid grid-cols-3 gap-2 text-sm">
          <div><dt className="text-muted-foreground">Speaker cosine</dt><dd>{reply.result.asv_cos?.toFixed(2) ?? "Unavailable"}</dd></div>
          <div><dt className="text-muted-foreground">Synthetic score</dt><dd>{reply.result.cm_p_spoof?.toFixed(2) ?? "Unavailable"}</dd></div>
          <div><dt className="text-muted-foreground">Spectral match</dt><dd>{reply.result.spec_sim?.toFixed(2) ?? "Unavailable"}</dd></div>
        </dl>
        <ul className="list-disc space-y-1 pl-5 text-sm">{reply.result.findings.map((finding, i) => <li key={i}>{finding}</li>)}</ul>
        <SpectrogramView spectrum={reply.result.spectrogram} />
        {reply.outcome.device_locked && <p className="text-sm text-red-500">Device locked. Sign in again to request an unlock challenge.</p>}
      </div>}
      {fallback && !mfaVerified && <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void verifyMfa(); }}>
        <label className="block space-y-1 text-sm">Authenticator code<Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric" autoComplete="one-time-code" maxLength={6} /></label>
        <Button disabled={mfaBusy || code.length !== 6}>{mfaBusy ? "Verifying…" : "Verify code"}</Button>
      </form>}
      {mfaVerified && <p role="status" className="font-medium">Authenticator verified.</p>}
    </>}
  </div>;
}
