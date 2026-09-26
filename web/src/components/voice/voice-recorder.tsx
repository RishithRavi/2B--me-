"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeRecorder } from "./native-recorder";
import { LiveSpectrum } from "./live-spectrum";

let sessionMicLabel = "";

type Props = {
  phrase: string;
  promptUrl?: string;
  onPromptEnded?: () => Promise<unknown>;
  onRecorded: (wav: Blob, promptEndMs: number) => Promise<void>;
  disabled?: boolean;
};

export function VoiceRecorder({ phrase, promptUrl, onPromptEnded, onRecorded, disabled }: Props) {
  const [label, setLabel] = useState(sessionMicLabel || process.env.NEXT_PUBLIC_VOICE_MIC_LABEL || "");
  const [phase, setPhase] = useState<"idle" | "opening" | "prompt" | "manual" | "recording" | "uploading">("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [mic, setMic] = useState("");
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const recorder = useRef<NativeRecorder | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const alive = useRef(true);
  const busy = useRef(false);
  const recording = useRef(false);
  const generation = useRef(0);
  const promptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { alive.current = true; return () => {
    alive.current = false;
    generation.current++;
    if (promptTimer.current) clearTimeout(promptTimer.current);
    audio.current?.pause();
    if (audio.current) { audio.current.onended = null; audio.current.onerror = null; audio.current.removeAttribute("src"); audio.current.load(); }
    void recorder.current?.close();
  }; }, []);

  async function cleanup() {
    if (promptTimer.current) clearTimeout(promptTimer.current);
    audio.current?.pause();
    if (audio.current) { audio.current.onended = null; audio.current.onerror = null; audio.current.removeAttribute("src"); audio.current.load(); }
    audio.current = null;
    await recorder.current?.close(); recorder.current = null;
    if (alive.current) setAnalyser(null);
  }

  async function record() {
    const active = recorder.current;
    if (!active || !alive.current || recording.current) return;
    recording.current = true;
    const token = generation.current;
    if (promptTimer.current) clearTimeout(promptTimer.current);
    try {
      const promptEndMs = active.context.currentTime * 1000;
      setPhase("recording"); setSeconds(0);
      // Capture starts immediately; the acknowledgement network request runs alongside it.
      const recorded = active.capture((s) => { if (alive.current) setSeconds(s); });
      active.beep();
      const [wav] = await Promise.all([recorded, onPromptEnded?.()]);
      if (token !== generation.current) return;
      await cleanup();
      if (!alive.current) return;
      setPhase("uploading");
      await onRecorded(wav, promptEndMs);
    } catch (e) {
      if (token !== generation.current) return;
      await cleanup();
      if (alive.current) setError(e instanceof Error ? e.message : "Recording failed.");
    } finally {
      if (token === generation.current) {
        recording.current = false; busy.current = false;
        if (alive.current) setPhase("idle");
      }
    }
  }

  async function start() {
    if (busy.current || disabled) return;
    const token = ++generation.current;
    busy.current = true; setError(""); setPhase("opening");
    try {
      const active = new NativeRecorder(); recorder.current = active;
      await active.open(label);
      if (!alive.current || token !== generation.current) { await active.close(); return; }
      sessionMicLabel = label;
      setMic(active.micName); setAnalyser(active.analyser);
      if (!promptUrl) { await record(); return; }
      const prompt = new Audio(); audio.current = prompt;
      prompt.preload = "none"; prompt.src = promptUrl;
      prompt.onended = () => { prompt.onended = null; void record(); };
      prompt.onerror = () => { if (alive.current && !recording.current) setPhase("manual"); };
      setPhase("prompt");
      promptTimer.current = setTimeout(() => {
        if (alive.current && token === generation.current && !recording.current) {
          prompt.pause(); setPhase("manual");
        }
      }, 12000);
      try { await prompt.play(); }
      catch { if (alive.current && token === generation.current) setPhase("manual"); }
    } catch (e) {
      if (token !== generation.current) return;
      await cleanup(); busy.current = false;
      if (alive.current) { setError(e instanceof Error ? e.message : "Microphone unavailable."); setPhase("idle"); }
    }
  }

  return <div className="space-y-4">
    <p className="rounded-xl bg-muted p-5 text-center text-xl font-medium leading-relaxed">{phrase}</p>
    <label className="block space-y-1 text-sm">Demo microphone name
      <Input value={label} onChange={(e) => setLabel(e.target.value)} disabled={phase !== "idle" || disabled}
        placeholder="Name of your USB microphone" autoComplete="off" />
    </label>
    <p className="text-xs text-muted-foreground">Only the microphone matching this name can record. Keep it close and read all five words.</p>
    {mic && <p className="text-sm">Microphone: {mic}</p>}
    {analyser && <LiveSpectrum analyser={analyser} />}
    <div role="status" aria-live="polite" className="text-sm">
      {phase === "opening" && "Opening microphone…"}
      {phase === "prompt" && "Listen to the phrase. Recording starts when it finishes."}
      {phase === "manual" && "Prompt playback is unavailable. Read the displayed phrase after pressing Speak now."}
      {phase === "recording" && <p className="rounded-full border-2 border-red-500 px-4 py-2 text-red-500">● REC · {Math.max(0, 6 - seconds).toFixed(1)} seconds remaining</p>}
      {phase === "uploading" && "Checking your response…"}
    </div>
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    {phase === "idle" && <Button onClick={() => void start()} disabled={disabled || !label.trim()}>Start voice check</Button>}
    {phase === "manual" && <Button onClick={() => { audio.current?.pause(); void record(); }}>Speak now</Button>}
    {phase !== "idle" && phase !== "uploading" && <Button variant="outline" onClick={() => {
      generation.current++; recording.current = false;
      void cleanup().then(() => { busy.current = false; if (alive.current) setPhase("idle"); });
    }}>Cancel recording</Button>}
  </div>;
}
