import { describe, expect, it } from "vitest";

import type { VoiceStageLive } from "@/lib/contracts";
import type { LiveVoiceResult } from "@/lib/live";

import { currentVoiceView } from "./voice-analysis";
import { DECISION_META, dspRows, fmtDsp, isSimulated, scoringMs, stageTiles } from "./voice-format";

const spoof: LiveVoiceResult = {
  challenge_id: "c1",
  decision: "BLOCK_SPOOF",
  voice_confidence: 0.31,
  asv_cos: 0.58,
  cm_p_spoof: 0.93,
  spec_sim: 0.61,
  phrase_wer: 0,
  onset_ms: 610,
  dsp: { centroid_hz: 1840, hf_ratio_db: -9.1, f0_median_hz: 118, zz_custom_ms: 12 },
  findings: ["anti-spoof: synthetic speech 0.93"],
  stage_ms: { stt: 420, cm: 1100, asv: 90, dsp: 60, total: 1675 },
  simulated: true,
  t: "2026-09-27T14:00:00.000Z",
};

const stage = (s: VoiceStageLive["stage"], ok: boolean | null, value: number | null): VoiceStageLive => ({ challenge_id: "c1", stage: s, ok, value });

describe("stageTiles", () => {
  it("derives the four outcomes from the result (the demo's spoof beat)", () => {
    const t = stageTiles(spoof, []);
    expect(t.map((x) => x.label)).toEqual(["Words", "Speaker", "Anti-spoof", "Spectral"]);
    expect(t.map((x) => x.value)).toEqual([0, 0.58, 0.93, 0.61]);
    expect(t.map((x) => x.ok)).toEqual([true, true, false, null]); // speaker would pass alone; anti-spoof decides
    expect(t.every((x) => !x.pending)).toBe(true);
  });

  it("live stage events win over derived flags and fill in while scoring", () => {
    const t = stageTiles(null, [stage("transcribing", true, 0.0), stage("anti-spoof", false, 0.9)]);
    expect(t[0]).toMatchObject({ ok: true, value: 0, pending: false });
    expect(t[1]).toMatchObject({ key: "speaker", pending: true, value: null });
    expect(t[2]).toMatchObject({ ok: false, value: 0.9, pending: false });
  });
});

describe("dspRows", () => {
  it("labels known keys with units, known keys first, unknown keys humanized", () => {
    const rows = dspRows(spoof.dsp);
    expect(rows.map((r) => r.key)).toEqual(["f0_median_hz", "hf_ratio_db", "centroid_hz", "zz_custom_ms"]);
    expect(rows[0]).toMatchObject({ label: "F0 (median pitch)", value: "118 Hz" });
    expect(rows[1]).toMatchObject({ label: "HF energy vs profile", value: "−9.1 dB" });
    expect(rows[3]).toMatchObject({ label: "Zz custom", value: "12 ms" });
  });

  it("formats the real pipeline's keys and drops non-finite values", () => {
    const rows = dspRows({ hf_energy_ratio: 0.0123, spectral_flatness: 0.41234, jitter_pct: 0.31, bad: Number.NaN });
    expect(rows.map((r) => r.value)).toEqual(["0.31 %", "1.2 %", "0.412"]);
    expect(dspRows(null)).toEqual([]);
  });

  it("fmtDsp handles Hz / dB / %", () => {
    expect(fmtDsp(96.44, "Hz")).toBe("96.4 Hz");
    expect(fmtDsp(2.5, "dB")).toBe("2.5 dB");
    expect(fmtDsp(-0.5, "%")).toBe("−0.50 %");
  });
});

describe("stub honesty", () => {
  it("a result is simulated when the server runs stub voice or flags it", () => {
    expect(isSimulated({ simulated: false }, "stub")).toBe(true);
    expect(isSimulated({ simulated: true }, "real")).toBe(true);
    expect(isSimulated({ simulated: false }, "real")).toBe(false);
    expect(isSimulated(null, null)).toBe(false);
  });

  it("every decision has banner copy", () => {
    for (const d of ["VERIFY", "RETRY", "FALLBACK_MFA", "BLOCK_SPOOF", "BLOCK_IMPOSTOR"] as const) {
      expect(DECISION_META[d].label.length).toBeGreaterThan(5);
    }
  });

  it("scoringMs prefers the total", () => {
    expect(scoringMs(spoof.stage_ms)).toBe(1675);
    expect(scoringMs({ stt: 100, cm: 50 })).toBe(150);
    expect(scoringMs({})).toBeNull();
  });
});

describe("currentVoiceView", () => {
  const now = Date.parse(spoof.t) + 5_000;
  const empty = { voiceResults: [], voiceStages: {}, open_challenge: null, markers: [] };

  it("shows the newest result since the last reset, for 10 minutes", () => {
    expect(currentVoiceView(empty, now)).toBeNull();
    expect(currentVoiceView({ ...empty, voiceResults: [spoof] }, now)?.result?.decision).toBe("BLOCK_SPOOF");
    expect(currentVoiceView({ ...empty, voiceResults: [spoof] }, now + 11 * 60_000)).toBeNull();
    const reset = [{ t: "2026-09-27T14:00:03.000Z", label: "reset" as const, text: null }];
    expect(currentVoiceView({ ...empty, voiceResults: [spoof], markers: reset }, now)).toBeNull();
  });

  it("shows a check being scored on the open challenge before its result", () => {
    const oc = { challenge_id: "c2", trigger: "step_up" as const, status: "scoring" as const, attempt: 1, expires_at: null, verify_url: null };
    const v = currentVoiceView({ ...empty, voiceResults: [spoof], open_challenge: oc, voiceStages: { c2: [] } }, now);
    expect(v).toMatchObject({ challengeId: "c2", result: null });
  });
});
