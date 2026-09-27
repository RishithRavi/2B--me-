export function selectMicrophone(devices: MediaDeviceInfo[], label: string): MediaDeviceInfo {
  const wanted = label.trim().toLowerCase();
  if (!wanted) throw new Error("Enter the name of the demo microphone before recording.");
  const matches = devices.filter((d) => d.kind === "audioinput" &&
    !["default", "communications"].includes(d.deviceId) && d.label.toLowerCase().includes(wanted));
  if (matches.length !== 1) {
    throw new Error(matches.length ? "More than one microphone matches. Use its full name." :
      "The required microphone is unavailable. Check its name and connection.");
  }
  return matches[0];
}

/** One capture session. Construct and open only from a user gesture. */
export class NativeRecorder {
  readonly context = new AudioContext(); // native sample rate; server owns resampling
  analyser: AnalyserNode | null = null;
  micName = "";
  openedAtMs = 0;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private mute: GainNode | null = null;
  private closed = false;
  private rejectCapture: ((reason: Error) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  async open(label: string) {
    if (!label.trim()) { await this.close(); throw new Error("Enter the demo microphone name."); }
    if (!navigator.mediaDevices?.getUserMedia) {
      await this.close(); throw new Error("Microphone capture requires HTTPS and a supported browser.");
    }
    const constraints = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    try {
      await this.context.resume();
      // Permission reveals device labels; never retain or analyze this probe stream.
      const permission = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      permission.getTracks().forEach((track) => track.stop());
      this.checkOpen();
      const pinned = selectMicrophone(await navigator.mediaDevices.enumerateDevices(), label);
      this.checkOpen();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...constraints, deviceId: { exact: pinned.deviceId } } });
      if (this.closed) { stream.getTracks().forEach((t) => t.stop()); this.checkOpen(); }
      this.stream = stream;
      const track = stream.getAudioTracks()[0];
      if (!track || track.getSettings().deviceId !== pinned.deviceId) throw new Error("The browser selected another microphone.");
      this.micName = track.label;
      this.openedAtMs = this.context.currentTime * 1000;
      track.onended = () => { void this.close(); };
      await this.context.audioWorklet.addModule("/worklets/voice-pcm.js");
      this.checkOpen();
      this.node = new AudioWorkletNode(this.context, "voice-pcm");
      this.source = this.context.createMediaStreamSource(stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 512;
      this.mute = this.context.createGain();
      this.mute.gain.value = 0;
      this.source.connect(this.analyser);
      this.analyser.connect(this.node);
      this.node.connect(this.mute).connect(this.context.destination);
    } catch (error) { await this.close(); throw error; }
  }

  capture(onProgress: (seconds: number) => void): Promise<Blob> {
    this.checkOpen();
    if (!this.node || this.rejectCapture) throw new Error("Recorder is not ready.");
    return new Promise((resolve, reject) => {
      this.rejectCapture = reject;
      this.timer = setTimeout(() => { void this.close(); }, 9000);
      this.node!.port.onmessage = ({ data }) => {
        if (data.type === "progress") onProgress(data.seconds);
        if (data.type === "complete") {
          if (this.timer) clearTimeout(this.timer);
          this.timer = null;
          this.rejectCapture = null;
          this.node!.port.onmessage = null;
          resolve(new Blob([data.buffer], { type: "audio/wav" }));
        }
      };
      this.node!.port.postMessage({ type: "record", startFrame: this.context.currentTime * this.context.sampleRate });
    });
  }

  beep() {
    this.checkOpen();
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.025;
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(); oscillator.stop(this.context.currentTime + 0.06);
  }

  private checkOpen() {
    if (this.closed) throw new Error("Recording was cancelled or the microphone disconnected.");
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.rejectCapture?.(new Error("Recording stopped. Check the microphone and try again."));
    this.rejectCapture = null;
    this.node?.port.postMessage({ type: "cancel" });
    this.node?.disconnect(); this.source?.disconnect(); this.analyser?.disconnect(); this.mute?.disconnect();
    this.stream?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    this.stream = null;
    if (this.context.state !== "closed") await this.context.close();
  }
}
