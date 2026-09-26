// STUB (A0) — owner: Codex 2
// Minimal mic capture for the /verify stub: native-rate AudioContext + ScriptProcessorNode (no worklet),
// collecting mono Float32 samples. Codex 2 replaces this with the AudioWorklet recorder (§8 C3).
import { concatFloat32 } from "./wav";

export class MicCapture {
  readonly ctx: AudioContext;
  private stream: MediaStream | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private proc: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private count = 0;
  /** RMS of the last buffer (0..1), for the level meter. */
  level = 0;

  /** Create inside the click handler (user gesture) so resume() is allowed. Native rate: no sampleRate option. */
  constructor() {
    this.ctx = new AudioContext();
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  /** Samples captured so far. */
  get length(): number {
    return this.count;
  }

  async open(): Promise<void> {
    await this.ctx.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0; // keep the graph pulling without echoing the mic
    this.proc.onaudioprocess = (e: AudioProcessingEvent) => {
      const ch = e.inputBuffer.getChannelData(0);
      const copy = new Float32Array(ch);
      this.chunks.push(copy);
      this.count += copy.length;
      let s = 0;
      for (let i = 0; i < copy.length; i++) s += copy[i] * copy[i];
      this.level = Math.sqrt(s / copy.length);
    };
    this.src.connect(this.proc);
    this.proc.connect(this.sink);
    this.sink.connect(this.ctx.destination);
  }

  /** All samples from `fromSample` on. */
  samples(fromSample = 0): Float32Array {
    const all = concatFloat32(this.chunks);
    return all.subarray(Math.min(fromSample, all.length));
  }

  close(): void {
    if (this.proc) this.proc.onaudioprocess = null;
    try {
      this.src?.disconnect();
      this.proc?.disconnect();
      this.sink?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx.close().catch(() => undefined);
  }
}

/** Play a short synthetic beep (mock mode / no prompt URL). Resolves when it ends. */
export function beep(ctx: AudioContext, seconds = 0.9, hz = 880): Promise<void> {
  return new Promise((resolve) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + seconds);
    osc.connect(gain).connect(ctx.destination);
    osc.onended = () => resolve();
    osc.start();
    osc.stop(ctx.currentTime + seconds);
  });
}

/** Play the prompt through an <audio> element. Rejects if autoplay/gesture rules block it or the file errors. */
export function playPrompt(audio: HTMLAudioElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEnded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("prompt audio failed to load"));
    };
    const cleanup = () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    audio.play().catch((e: unknown) => {
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}
