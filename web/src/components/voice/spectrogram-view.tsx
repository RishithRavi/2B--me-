"use client";
import { useEffect, useRef } from "react";
import type { Spectrogram } from "@/lib/contracts";

export function SpectrogramView({ spectrum }: { spectrum: Spectrogram | null | undefined }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx || !spectrum) return;
    ctx.clearRect(0, 0, 512, 128);
    spectrum.db.forEach((band, f) => band.forEach((db, t) => {
      const intensity = Math.max(0, Math.min(1, (db + 100) / 100));
      ctx.fillStyle = `hsl(${250 - intensity * 210} 75% ${10 + intensity * 65}%)`;
      ctx.fillRect(t * 512 / band.length, 128 - (f + 1) * 128 / spectrum.db.length,
        512 / band.length + 1, 128 / spectrum.db.length + 1);
    }));
  }, [spectrum]);
  if (!spectrum) return null;
  return <figure className="space-y-1"><canvas ref={canvas} width={512} height={128}
    className="h-32 w-full rounded-lg bg-muted" aria-label="Response spectrogram, time left to right and frequency bottom to top" />
    <figcaption className="text-xs text-muted-foreground">Response spectrum · time → · frequency ↑</figcaption></figure>;
}
