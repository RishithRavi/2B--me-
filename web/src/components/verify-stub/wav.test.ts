import { describe, expect, it } from "vitest";

import { concatFloat32, encodeWav } from "./wav";

const ascii = (v: DataView, off: number, n: number) => String.fromCharCode(...Array.from({ length: n }, (_, i) => v.getUint8(off + i)));

describe("encodeWav", () => {
  it("writes a valid 16-bit PCM mono RIFF header", () => {
    const samples = new Float32Array(480);
    const buf = encodeWav(samples, 48000);
    const v = new DataView(buf);
    expect(buf.byteLength).toBe(44 + 480 * 2);
    expect(ascii(v, 0, 4)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 960);
    expect(ascii(v, 8, 4)).toBe("WAVE");
    expect(ascii(v, 12, 4)).toBe("fmt ");
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(28, true)).toBe(96000);
    expect(v.getUint16(32, true)).toBe(2);
    expect(v.getUint16(34, true)).toBe(16);
    expect(ascii(v, 36, 4)).toBe("data");
    expect(v.getUint32(40, true)).toBe(960);
  });

  it("scales and clips samples to int16", () => {
    const v = new DataView(encodeWav(new Float32Array([0, 1, -1, 0.5, 2, -3, Number.NaN]), 16000));
    const at = (i: number) => v.getInt16(44 + i * 2, true);
    expect(at(0)).toBe(0);
    expect(at(1)).toBe(32767);
    expect(at(2)).toBe(-32768);
    expect(at(3)).toBe(16384);
    expect(at(4)).toBe(32767); // clipped
    expect(at(5)).toBe(-32768); // clipped
    expect(at(6)).toBe(0); // NaN → silence
  });

  it("rounds a non-integer native rate", () => {
    const v = new DataView(encodeWav(new Float32Array(1), 44100.4));
    expect(v.getUint32(24, true)).toBe(44100);
  });

  it("concatenates chunks in order", () => {
    const out = concatFloat32([new Float32Array([1, 2]), new Float32Array([]), new Float32Array([3])]);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
});
