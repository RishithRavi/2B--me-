import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionOut, VoiceOutcome } from "@/lib/contracts";
import { resolveCheckout } from "./checkout-result";
import { NativeRecorder, selectMicrophone } from "./native-recorder";

const pending: DecisionOut = { decision_id: "order-a", status: "pending", decision: "step_up", trans_status: "C",
  confidence: 0.3, tier: "R3", binding: "remote", reasons: [], challenge_id: "challenge-a", verify_url: null };

it("only resolves the server-listed order and never reopens a declined order", () => {
  expect(resolveCheckout(pending, { device_locked: false, resolved_decisions: [] })).toBe(pending);
  const outcome: VoiceOutcome = { device_locked: true, resolved_decisions: [{ decision_id: "order-a", decision: "block", trans_status: "N" }] };
  const blocked = resolveCheckout(pending, outcome)!;
  expect(blocked.trans_status).toBe("N");
  expect(resolveCheckout(blocked, { device_locked: false, resolved_decisions: [{ decision_id: "order-a", decision: "allow", trans_status: "Y" }] })).toBe(blocked);
  expect(resolveCheckout(pending, { device_locked: false, resolved_decisions: [{ decision_id: "other-order", decision: "allow", trans_status: "Y" }] })).toBe(pending);
});

it("requires one specific matching microphone, never a default fallback", () => {
  const device = (id: string, label: string) => ({ deviceId: id, kind: "audioinput", label }) as MediaDeviceInfo;
  const devices = [device("default", "USB Demo"), device("one", "USB Demo"), device("two", "Built-in")];
  expect(selectMicrophone(devices, "usb demo").deviceId).toBe("one");
  expect(() => selectMicrophone(devices, "")).toThrow();
  expect(() => selectMicrophone(devices, "missing")).toThrow();
  expect(() => selectMicrophone([...devices, device("three", "USB Demo")], "usb")).toThrow();
});

type Message = { type: string; buffer?: ArrayBuffer };
type Processor = { port: { onmessage: (event: { data: unknown }) => void }; process: (input: Float32Array[][]) => boolean };
function worklet(rate: number) {
  const messages: Message[] = [];
  let Constructor: new () => Processor;
  const context = vm.createContext({ sampleRate: rate, currentFrame: 0, Float32Array, ArrayBuffer, DataView,
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (data: Message) => messages.push(data) }; },
    registerProcessor: (_: string, cls: new () => Processor) => { Constructor = cls; },
  });
  vm.runInContext(readFileSync(new URL("../../../public/worklets/voice-pcm.js", import.meta.url), "utf8"), context);
  const processor = new Constructor!();
  const run = (value: number, blocks: number) => {
    for (let i = 0; i < blocks; i++) { processor.process([[new Float32Array(128).fill(value)]]); context.currentFrame += 128; }
  };
  return { messages, context, processor, run };
}

describe("native AudioWorklet PCM capture", () => {
  for (const rate of [44100, 48000]) it(`discards prompt audio and packs exactly six seconds at ${rate} Hz`, () => {
    const { messages, context, processor, run } = worklet(rate);
    run(0.9, 50); expect(messages).toHaveLength(0);
    processor.port.onmessage({ data: { type: "record", startFrame: context.currentFrame + 256 } });
    run(-0.9, 2); run(0.25, Math.ceil(rate * 6 / 128) + 1);
    const complete = messages.filter((m) => m.type === "complete");
    expect(complete).toHaveLength(1);
    const buffer = complete[0].buffer!;
    const wav = new DataView(buffer);
    expect(buffer.byteLength).toBe(44 + rate * 6 * 2);
    expect(wav.getUint32(24, true)).toBe(rate);
    expect(wav.getUint16(22, true)).toBe(1);
    expect(wav.getInt16(44, true)).toBe(8192);
    expect(wav.getInt16(buffer.byteLength - 2, true)).toBe(8192);
  });
  it("cancels an incomplete take without emitting audio", () => {
    const { messages, processor, run } = worklet(48000);
    processor.port.onmessage({ data: { type: "record", startFrame: 0 } });
    run(1, 10); processor.port.onmessage({ data: { type: "cancel" } }); run(1, 2300);
    expect(messages.some((m) => m.type === "complete")).toBe(false);
  });
});

describe("microphone resource cleanup", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  function audioContext() {
    const close = vi.fn(async () => {});
    vi.stubGlobal("AudioContext", class {
      state = "running";
      resume = vi.fn(async () => {});
      close = close;
    });
    return close;
  }
  it("stops a late permission stream when the user cancels while permission is pending", async () => {
    const close = audioContext();
    let grant!: (stream: unknown) => void;
    const getUserMedia = vi.fn(() => new Promise((resolve) => { grant = resolve; }));
    const enumerateDevices = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia, enumerateDevices } });
    const recorder = new NativeRecorder();
    const opening = recorder.open("USB");
    const rejected = expect(opening).rejects.toThrow("cancelled");
    await Promise.resolve();
    await recorder.close();
    const stop = vi.fn();
    grant({ getTracks: () => [{ stop }] });
    await rejected;
    expect(stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(enumerateDevices).not.toHaveBeenCalled();
  });
  it("closes a stream when the browser returns the wrong microphone", async () => {
    const close = audioContext();
    const probeStop = vi.fn();
    const selectedStop = vi.fn();
    const track = { stop: selectedStop, getSettings: () => ({ deviceId: "wrong" }) };
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce({ getTracks: () => [{ stop: probeStop }] })
      .mockResolvedValueOnce({ getTracks: () => [track], getAudioTracks: () => [track] });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia,
      enumerateDevices: async () => [{ deviceId: "pinned", kind: "audioinput", label: "USB Demo" }] } });
    await expect(new NativeRecorder().open("USB Demo")).rejects.toThrow("another microphone");
    expect(getUserMedia.mock.calls[1][0].audio.deviceId).toEqual({ exact: "pinned" });
    expect(probeStop).toHaveBeenCalledOnce();
    expect(selectedStop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
