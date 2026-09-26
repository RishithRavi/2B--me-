"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import type { VoiceEnrollOut, VoiceEnrollStartOut } from "@/lib/contracts";
import { VoiceRecorder } from "./voice-recorder";

export function VoiceEnroll({ onDone }: { onDone?: (result: VoiceEnrollOut) => void }) {
  const [enrollment, setEnrollment] = useState<VoiceEnrollStartOut | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);
  const takes = useRef<Blob[]>([]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; takes.current = []; }; }, []);
  async function start() {
    setBusy(true); setError(""); takes.current = [];
    try { const next = await api.voiceEnrollStart(); if (mounted.current) { setEnrollment(next); setIndex(0); } }
    catch (e) { if (mounted.current) setError(errorMessage(e)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function recorded(wav: Blob) {
    if (!enrollment) return;
    takes.current.push(wav);
    if (takes.current.length < enrollment.phrases.length) { setIndex((i) => i + 1); return; }
    setBusy(true);
    try {
      const result = await api.voiceEnroll(enrollment.enroll_id, takes.current);
      if (mounted.current) { setComplete(result.enrolled); if (!result.enrolled) setError("Enrollment was not accepted. Please record five new phrases."); onDone?.(result); }
    } catch (e) { if (mounted.current) setError(errorMessage(e)); }
    finally { takes.current = []; if (mounted.current) { setBusy(false); setEnrollment(null); } }
  }
  return <div className="space-y-4">
    <h2 className="font-semibold">Enroll your voice</h2>
    <p className="text-sm text-muted-foreground">Record five phrases with the demo microphone. Takes remain in memory until all five are ready to upload.</p>
    {error && <p role="alert" className="text-red-500">{error}</p>}
    {complete ? <p role="status">Voice enrollment complete.</p> : enrollment ? <>
      <p className="text-sm">Phrase {index + 1} of {enrollment.phrases.length}</p>
      <VoiceRecorder key={`${enrollment.enroll_id}:${index}`} phrase={enrollment.phrases[index]} disabled={busy} onRecorded={recorded} />
    </> : <Button disabled={busy} onClick={() => void start()}>{busy ? "Starting…" : "Start voice enrollment"}</Button>}
  </div>;
}
