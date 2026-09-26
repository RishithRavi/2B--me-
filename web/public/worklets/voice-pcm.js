// Audio stays in memory. Discard prompt samples; collect exactly six native-rate seconds.
class VoicePCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = null;
    this.port.onmessage = ({ data }) => {
      if (data.type === "cancel") { this.recording = null; return; }
      if (data.type !== "record" || !Number.isFinite(data.startFrame)) return;
      const frames = Math.round(sampleRate * 6);
      this.recording = {
        start: Math.max(currentFrame, Math.ceil(data.startFrame)),
        samples: new Float32Array(frames), count: 0, nextProgress: 0,
      };
    };
  }

  process(inputs) {
    const take = this.recording;
    if (!take) return true;
    const channels = inputs[0] || [];
    const quantum = channels[0]?.length || 128;
    for (let i = 0; i < quantum && take.count < take.samples.length; i++) {
      if (currentFrame + i < take.start) continue;
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      take.samples[take.count++] = channels.length ? sample / channels.length : 0;
    }
    if (take.count >= take.nextProgress) {
      this.port.postMessage({ type: "progress", seconds: take.count / sampleRate });
      take.nextProgress = take.count + Math.round(sampleRate / 10);
    }
    if (take.count === take.samples.length) {
      const buffer = new ArrayBuffer(44 + take.count * 2);
      const view = new DataView(buffer);
      const text = (offset, value) => {
        for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
      };
      text(0, "RIFF"); view.setUint32(4, 36 + take.count * 2, true); text(8, "WAVE");
      text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
      view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true);
      view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, take.count * 2, true);
      for (let i = 0; i < take.count; i++) {
        const x = Math.max(-1, Math.min(1, take.samples[i]));
        view.setInt16(44 + 2 * i, Math.round(x * (x < 0 ? 32768 : 32767)), true);
      }
      this.recording = null;
      this.port.postMessage({ type: "complete", buffer }, [buffer]);
    }
    return true;
  }
}
registerProcessor("voice-pcm", VoicePCMProcessor);
