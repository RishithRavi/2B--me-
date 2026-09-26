"use client";
import { useEffect, useRef } from "react";

export function LiveSpectrum({ analyser }: { analyser: AnalyserNode | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!analyser) return;
    let frame = 0;
    const values = new Uint8Array(analyser.frequencyBinCount);
    const draw = () => {
      const ctx = canvas.current?.getContext("2d");
      if (ctx) {
        analyser.getByteFrequencyData(values);
        ctx.clearRect(0, 0, 640, 90); ctx.fillStyle = "#48bba9";
        for (let i = 0; i < 64; i++) {
          const h = values[i * 2] / 255 * 86;
          ctx.fillRect(i * 10, 90 - h, 7, h);
        }
      }
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [analyser]);
  return <canvas ref={canvas} width={640} height={90} className="h-20 w-full" aria-label="Live microphone frequency spectrum" />;
}
