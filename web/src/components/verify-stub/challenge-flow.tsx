// STUB (A0) — owner: Codex 2
"use client";

import { AlertTriangle, AudioLines, KeyRound, Loader2, Mic, ShieldQuestion, Volume2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import type { ChallengeOut, ChallengeResponseOut, TotpVerifyOut, VoiceDecision, VoiceStageLive } from "@/lib/contracts";
import { useNow } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

import { FAKE_DECISIONS, type VerifyBackend } from "./backend";
import { MicCapture, beep, playPrompt } from "./recorder";
import { OutcomeView, ResultView, StageRow } from "./result-view";
import { wavBlob } from "./wav";

const RECORD_S = 6.0;

const STATUS_AFTER: Record<VoiceDecision, ChallengeOut["status"]> = {
  VERIFY: "verified",
  RETRY: "retry",
  FALLBACK_MFA: "fallback_mfa",
  BLOCK_SPOOF: "blocked_spoof",
  BLOCK_IMPOSTOR: "blocked_impostor",
};

type Phase = "loading" | "failed" | "ready" | "arming" | "prompt" | "speak-now" | "recording" | "uploading" | "result" | "totp";

/** What we capture from: the real mic, or (mock mode without a mic) simulated low-level noise. */
interface Capture {
  readonly sampleRate: number;
  readonly length: number;
  readonly level: number;
  samples(from?: number): Float32Array;
  close(): void;
}

class SimCapture implements Capture {
  readonly sampleRate = 16000;
  private readonly t0 = performance.now();
  get length() {
    return Math.floor(((performance.now() - this.t0) / 1000) * this.sampleRate);
  }
  get level() {
    return 0.04 + Math.random() * 0.12;
  }
  samples(from = 0) {
    const n = Math.max(0, this.length - from);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = (Math.random() - 0.5) * 0.01;
    return out;
  }
  close() {}
}

function challengeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.offline) return "Can't reach the 2bME API.";
    if (e.status === 404) return "This challenge doesn't exist. It may have been reset or never issued.";
    if (e.status === 403) return "This challenge belongs to another account. Sign in as the device owner.";
    if (e.status === 401) return "Sign in to answer this challenge.";
    if (e.status === 409) return `This challenge can't take a reply right now (${e.detail}).`;
    return e.detail || `HTTP ${e.status}`;
  }
  return e instanceof Error ? e.message : String(e);
}

export function ChallengeFlow({
  challengeId,
  decisionId,
  backend,
  devControls,
}: {
  challengeId: string;
  decisionId: string | null;
  backend: VerifyBackend;
  devControls: boolean;
}) {
  const { state: live } = useLive();
  const now = useNow(1000);
  const [ch, setCh] = useState<ChallengeOut | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(RECORD_S);
  const [level, setLevel] = useState(0);
  const [fake, setFake] = useState<VoiceDecision>("VERIFY");
  const [res, setRes] = useState<ChallengeResponseOut | null>(null);
  const [stageBase, setStageBase] = useState<VoiceStageLive[] | undefined>(undefined);
  const [code, setCode] = useState("");
  const [totp, setTotp] = useState<TotpVerifyOut | null>(null);
  const [totpBusy, setTotpBusy] = useState(false);
  const capRef = useRef<Capture | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---- load ----
  useEffect(() => {
    let alive = true;
    setPhase("loading");
    backend
      .getChallenge(challengeId)
      .then((c) => {
        if (!alive) return;
        setCh(c);
        setPhase(c.status === "fallback_mfa" ? "totp" : "ready");
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(challengeError(e));
        setStatus(e instanceof ApiError ? e.status : null);
        setPhase("failed");
      });
    return () => {
      alive = false;
    };
  }, [challengeId, backend]);

  // ---- cleanup ----
  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
      capRef.current?.close();
    },
    [],
  );

  const liveStages = live.voiceStages[challengeId];
  const stages = stageBase !== undefined && liveStages !== stageBase ? (liveStages ?? []) : [];

  // ---- record 6 s after the prompt, then upload ----
  const recordAndSend = useCallback(
    async (cap: Capture) => {
      const endSample = cap.length;
      const promptEndMs = Math.round((endSample / cap.sampleRate) * 1000);
      void backend.promptEnded(challengeId).catch(() => undefined);
      setPhase("recording");
      const t0 = performance.now();
      setRemaining(RECORD_S);
      await new Promise<void>((resolve) => {
        timerRef.current = setInterval(() => {
          const left = Math.max(0, RECORD_S - (performance.now() - t0) / 1000);
          setRemaining(left);
          setLevel(cap.level);
          if (left <= 0) {
            if (timerRef.current) clearInterval(timerRef.current);
            timerRef.current = null;
            resolve();
          }
        }, 100);
      });
      // Keep samples from the prompt's end; send that offset (ms since the mic opened) as client_prompt_end_ms.
      const samples = cap.samples(endSample);
      const sr = cap.sampleRate;
      cap.close();
      capRef.current = null;
      setPhase("uploading");
      setStageBase(live.voiceStages[challengeId] ?? []);
      try {
        const out = await backend.respond(challengeId, wavBlob(samples, sr), promptEndMs, devControls ? fake : null, decisionId);
        setRes(out);
        setCh((c) => (c ? { ...c, status: STATUS_AFTER[out.result.decision] } : c));
        setPhase(out.result.decision === "FALLBACK_MFA" ? "totp" : "result");
      } catch (e) {
        setError(challengeError(e));
        setPhase("ready");
      }
    },
    [backend, challengeId, decisionId, devControls, fake, live.voiceStages],
  );

  // ---- the single user gesture: mic → prompt → record ----
  async function start() {
    if (!ch) return;
    setError(null);
    setNote(null);
    setRes(null);
    setStageBase(undefined);
    const url = backend.promptUrl(ch);
    const audio = url ? new Audio(url) : null;
    if (audio) {
      audio.preload = "auto";
      audio.load();
    }
    let cap: Capture;
    let mic: MicCapture | null = null;
    setPhase("arming");
    try {
      mic = new MicCapture();
      await mic.open();
      cap = mic;
    } catch (e) {
      mic?.close();
      if (!backend.mock) {
        setError(`Microphone unavailable: ${e instanceof Error ? e.message : String(e)}. Allow mic access and try again.`);
        setPhase("ready");
        return;
      }
      cap = new SimCapture();
      setNote("No microphone available. Mock mode is recording simulated audio.");
    }
    capRef.current = cap;
    setPhase("prompt");
    try {
      if (audio) await playPrompt(audio);
      else if (mic) await beep(mic.ctx);
      else await new Promise((r) => setTimeout(r, 900));
    } catch {
      // Autoplay blocked or prompt failed: show the phrase and let the user start speaking.
      setPhase("speak-now");
      return;
    }
    await recordAndSend(cap);
  }

  function retry() {
    if (!ch || !res?.next) return;
    setCh({ ...ch, phrase: res.next.phrase, prompt_url: res.next.prompt_url, expires_at: res.next.expires_at, attempt: res.next.attempt, status: "retry" });
    setRes(null);
    setStageBase(undefined);
    setPhase("ready");
  }

  async function submitTotp() {
    setTotpBusy(true);
    setError(null);
    try {
      const out = await backend.totp(challengeId, code, decisionId);
      setTotp(out);
      if (out.ok) setCh((c) => (c ? { ...c, status: "verified" } : c));
    } catch (e) {
      setError(challengeError(e));
    } finally {
      setTotpBusy(false);
    }
  }

  // ---- render ----
  if (phase === "loading") return <div className="panel h-64 animate-pulse" />;
  if (phase === "failed" || !ch) {
    return (
      <div className="panel flex flex-col items-center gap-3 px-6 py-12 text-center">
        <ShieldQuestion className="size-8 text-trust-watch" />
        <p className="font-medium">{error ?? "Challenge unavailable."}</p>
        <div className="flex gap-2">
          {status === 401 || status === 403 ? (
            <Button asChild size="sm">
              <Link href="/login">Log in</Link>
            </Button>
          ) : null}
          <Button asChild size="sm" variant="outline">
            <Link href="/verify">Back</Link>
          </Button>
        </div>
      </div>
    );
  }

  const expiresIn = ch.expires_at ? Math.max(0, Math.round((Date.parse(ch.expires_at) - now) / 1000)) : null;
  const busy = phase === "arming" || phase === "prompt" || phase === "recording" || phase === "uploading";

  return (
    <div className="space-y-4">
      <div className="panel space-y-6 p-6">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="outline" className="font-mono uppercase">
            {ch.trigger.replace("_", "-")}
          </Badge>
          <Badge variant="outline" className="font-mono">
            {ch.status.replace("_", " ")}
          </Badge>
          <Badge variant="outline" className="font-mono">
            attempt {ch.attempt}
          </Badge>
          {expiresIn !== null && (
            <span className={cn("tnum ml-auto font-mono text-xs", expiresIn < 30 ? "text-trust-suspicious" : "text-muted-foreground")}>
              {expiresIn > 0 ? `expires in ${Math.floor(expiresIn / 60)}:${String(expiresIn % 60).padStart(2, "0")}` : "expired"}
            </span>
          )}
        </div>

        <div className="text-center">
          <p className="eyebrow">Say this phrase after the tone</p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">&ldquo;{ch.phrase}&rdquo;</p>
        </div>

        <div className="flex flex-col items-center gap-4">
          {phase === "recording" ? (
            <div className="relative grid size-36 place-items-center">
              <span
                className="absolute inset-0 rounded-full border-4 border-trust-suspicious transition-transform"
                style={{ transform: `scale(${1 + Math.min(0.25, level * 2.5)})`, boxShadow: "0 0 32px color-mix(in oklch, var(--trust-suspicious) 45%, transparent)" }}
              />
              <div className="text-center">
                <div className="flex items-center justify-center gap-1.5 text-xs font-semibold tracking-widest text-trust-suspicious">
                  <span className="size-2 animate-pulse rounded-full bg-trust-suspicious" /> REC
                </div>
                <div className="tnum font-mono text-4xl font-semibold">{remaining.toFixed(1)}</div>
              </div>
            </div>
          ) : phase === "speak-now" ? (
            <Button size="lg" className="h-14 px-8 text-lg" onClick={() => capRef.current && void recordAndSend(capRef.current)}>
              <Mic className="size-5" /> Speak now
            </Button>
          ) : phase === "ready" || phase === "result" ? (
            phase === "ready" && (
              <Button size="lg" className="h-14 px-8 text-lg" onClick={() => void start()}>
                <AudioLines className="size-5" /> Start voice check
              </Button>
            )
          ) : phase === "totp" ? null : (
            <div className="flex h-14 items-center gap-2 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
              {phase === "arming" && "Opening the microphone…"}
              {phase === "prompt" && (
                <>
                  <Volume2 className="size-4" /> Playing the prompt…
                </>
              )}
              {phase === "uploading" && "Scoring your reply…"}
            </div>
          )}
          {phase === "speak-now" && <p className="text-xs text-muted-foreground">The prompt couldn&apos;t play. Read the phrase above aloud.</p>}
          {note && <p className="text-xs text-trust-watch">{note}</p>}
          {error && (
            <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
              <AlertTriangle className="size-4" /> {error}
            </p>
          )}
        </div>

        {devControls && (
          <div className="flex flex-wrap items-center justify-center gap-2 border-t pt-4 text-xs text-muted-foreground">
            <span className="font-mono uppercase">dev</span>
            <label htmlFor="fake-decision">Stub decision</label>
            <select
              id="fake-decision"
              value={fake}
              onChange={(e) => setFake(e.target.value as VoiceDecision)}
              disabled={busy}
              className="h-7 rounded-md border bg-background px-2 font-mono text-xs"
            >
              {FAKE_DECISIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <span>sent as X-Fake-Decision</span>
          </div>
        )}
      </div>

      {(phase === "uploading" || res) && (
        <div className="panel space-y-4 p-6">
          <StageRow stages={stages} result={res?.result ?? null} busy={phase === "uploading"} />
          {res && phase === "result" && <ResultView res={res} decisionId={decisionId} onRetry={retry} />}
        </div>
      )}

      {phase === "totp" && (
        <div className="panel space-y-4 p-6">
          <div className="flex items-center gap-2">
            <KeyRound className="size-5 text-brand" />
            <h3 className="font-semibold">Enter your authenticator code</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            The voice check was inconclusive, so a TOTP code from your authenticator app completes it.
            {backend.mock ? " (Mock mode: 123456 passes.)" : ""}
          </p>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submitTotp();
            }}
          >
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              aria-label="6-digit code"
              className="tnum h-11 w-40 text-center font-mono text-xl tracking-[0.35em]"
            />
            <Button type="submit" disabled={code.length !== 6 || totpBusy} className="h-11">
              {totpBusy ? <Loader2 className="animate-spin" /> : null} Verify code
            </Button>
          </form>
          {totp && (
            <div className="space-y-3">
              <Badge
                className="h-7 px-3 font-mono"
                style={{
                  color: totp.ok ? "var(--trust-normal)" : "var(--trust-suspicious)",
                  background: `color-mix(in oklch, ${totp.ok ? "var(--trust-normal)" : "var(--trust-suspicious)"} 16%, transparent)`,
                }}
              >
                {totp.ok ? "TOTP verified" : "TOTP rejected"}
              </Badge>
              <OutcomeView outcome={totp.outcome} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
