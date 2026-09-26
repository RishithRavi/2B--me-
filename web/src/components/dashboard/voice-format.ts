// Pure presentation helpers for a voice check result (unit-tested): decision meta, the four stage tiles and the
// DSP/FFT rows. Keys in `dsp` differ between the stub, the mock stream and the real Hearsay pipeline, so known
// keys get a label and unit and anything else is humanized from its name.
import type { VoiceDecision, VoiceResultLive, VoiceStageLive } from "@/lib/contracts";

export interface DecisionMeta {
  label: string;
  sub: string;
  color: string;
  tone: "ok" | "warn" | "block";
}

export const DECISION_META: Record<VoiceDecision, DecisionMeta> = {
  VERIFY: {
    label: "Verified — it's the owner",
    sub: "Speaker matched, live speech, right words. Trust re-anchored.",
    color: "var(--trust-normal)",
    tone: "ok",
  },
  RETRY: {
    label: "Retry — a new phrase",
    sub: "Gray zone. The owner is never locked out by a gray result.",
    color: "var(--trust-watch)",
    tone: "warn",
  },
  FALLBACK_MFA: {
    label: "Inconclusive — authenticator code",
    sub: "Voice stayed in the gray zone; TOTP decides.",
    color: "var(--trust-watch)",
    tone: "warn",
  },
  BLOCK_SPOOF: {
    label: "Blocked — synthetic (cloned) voice",
    sub: "The anti-spoof check caught generated speech. Order declined, device locked.",
    color: "var(--trust-suspicious)",
    tone: "block",
  },
  BLOCK_IMPOSTOR: {
    label: "Blocked — a different speaker",
    sub: "The voice didn't match the enrolled owner. Order declined, device locked.",
    color: "var(--trust-suspicious)",
    tone: "block",
  },
};

export type StageKey = Exclude<VoiceStageLive["stage"], "done">;

export interface StageTile {
  key: StageKey;
  label: string;
  metric: string;
  hint: string;
  value: number | null;
  /** true pass · false fail · null informational / not decided yet */
  ok: boolean | null;
  /** no live event and no result yet */
  pending: boolean;
}

const STAGE_DEFS: { key: StageKey; label: string; metric: string; hint: string }[] = [
  { key: "transcribing", label: "Words", metric: "WER", hint: "spoken phrase vs the fresh prompt (STT)" },
  { key: "speaker", label: "Speaker", metric: "ASV cosine", hint: "ECAPA embedding vs the enrolled owner" },
  { key: "anti-spoof", label: "Anti-spoof", metric: "p(spoof)", hint: "deepfake / clone detector" },
  { key: "spectral", label: "Spectral", metric: "similarity", hint: "LTAS + MFCC vs the enrolled profile" },
];

function resultValue(r: VoiceResultLive, k: StageKey): number | null {
  switch (k) {
    case "transcribing":
      return r.phrase_wer;
    case "speaker":
      return r.asv_cos;
    case "anti-spoof":
      return r.cm_p_spoof;
    case "spectral":
      return r.spec_sim;
  }
}

function resultOk(r: VoiceResultLive, k: StageKey): boolean | null {
  switch (k) {
    case "transcribing":
      return r.decision !== "RETRY";
    case "speaker":
      return r.decision !== "BLOCK_IMPOSTOR";
    case "anti-spoof":
      return r.decision !== "BLOCK_SPOOF";
    case "spectral":
      return null;
  }
}

/** Four stage tiles from live voice_stage events (while scoring) and/or the final result. */
export function stageTiles(result: VoiceResultLive | null, stages: VoiceStageLive[]): StageTile[] {
  const byKey = new Map(stages.map((s) => [s.stage, s]));
  return STAGE_DEFS.map((d) => {
    const ev = byKey.get(d.key);
    const value = result ? resultValue(result, d.key) : (ev?.value ?? null);
    const ok = ev && ev.ok !== null ? ev.ok : result ? resultOk(result, d.key) : null;
    return { ...d, value: value ?? ev?.value ?? null, ok, pending: !ev && !result };
  });
}

export interface DspRow {
  key: string;
  label: string;
  value: string;
  hint: string;
}

const DSP_META: Record<string, { label: string; unit: string; hint: string }> = {
  f0_median_hz: { label: "F0 (median pitch)", unit: "Hz", hint: "autocorrelation pitch" },
  f0_hz: { label: "F0 (pitch)", unit: "Hz", hint: "fundamental frequency" },
  hnr_db: { label: "HNR", unit: "dB", hint: "harmonics-to-noise ratio" },
  jitter_pct: { label: "Jitter", unit: "%", hint: "cycle-to-cycle pitch variation" },
  shimmer_pct: { label: "Shimmer", unit: "%", hint: "cycle-to-cycle loudness variation" },
  hf_energy_ratio: { label: "HF energy > 4 kHz", unit: "frac", hint: "share of energy in the high band (FFT)" },
  hf_ratio_db: { label: "HF energy vs profile", unit: "dB", hint: "4–8 kHz band vs the enrolled owner" },
  centroid_hz: { label: "Spectral centroid", unit: "Hz", hint: "center of mass of the spectrum" },
  spectral_centroid_hz: { label: "Spectral centroid", unit: "Hz", hint: "center of mass of the spectrum" },
  spectral_rolloff_hz: { label: "Spectral roll-off", unit: "Hz", hint: "85% of energy lies below" },
  spectral_flatness: { label: "Spectral flatness", unit: "", hint: "tonal (0) vs noise-like (1)" },
  rms: { label: "RMS level", unit: "", hint: "loudness of the reply" },
};

const UNIT_SUFFIX: [string, string][] = [
  ["_hz", "Hz"],
  ["_db", "dB"],
  ["_pct", "%"],
  ["_ms", "ms"],
  ["_ratio", "frac"],
];

function humanize(key: string): { label: string; unit: string } {
  let unit = "";
  let base = key;
  for (const [suf, u] of UNIT_SUFFIX) {
    if (key.endsWith(suf)) {
      unit = u;
      base = key.slice(0, -suf.length);
      break;
    }
  }
  const words = base.split("_").filter(Boolean).join(" ");
  return { label: words ? words[0].toUpperCase() + words.slice(1) : key, unit };
}

/** 118 Hz · −9.1 dB · 0.31 % · 1.2 % (frac) · 0.412 */
export function fmtDsp(v: number, unit: string): string {
  if (!Number.isFinite(v)) return "—";
  const minus = (s: string) => s.replace(/^-/, "−");
  switch (unit) {
    case "Hz":
      return `${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)} Hz`;
    case "dB":
      return `${minus(v.toFixed(1))} dB`;
    case "%":
      return `${minus(v.toFixed(2))} %`;
    case "ms":
      return `${v.toFixed(0)} ms`;
    case "frac":
      return `${minus((v * 100).toFixed(1))} %`;
    default:
      return minus(Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3));
  }
}

/** DSP/FFT rows in a stable order: known keys first (table order), then the rest alphabetically. */
export function dspRows(dsp: Record<string, number> | null | undefined): DspRow[] {
  if (!dsp) return [];
  const known = Object.keys(DSP_META);
  const keys = Object.keys(dsp)
    .filter((k) => typeof dsp[k] === "number" && Number.isFinite(dsp[k]))
    .sort((a, b) => {
      const ia = known.indexOf(a);
      const ib = known.indexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a.localeCompare(b);
    });
  return keys.map((k) => {
    const meta = DSP_META[k] ?? { ...humanize(k), hint: k };
    return { key: k, label: meta.label, value: fmtDsp(dsp[k], meta.unit), hint: meta.hint };
  });
}

/** Stub voice: a result is simulated when the server says so, or when the server runs VOICE_MODE=stub. */
export function isSimulated(result: Pick<VoiceResultLive, "simulated"> | null | undefined, voiceMode: string | null): boolean {
  return voiceMode === "stub" || !!result?.simulated;
}

/** Total scoring latency from stage_ms (the stub's `total`, else the sum of stages). */
export function scoringMs(stageMs: Record<string, number> | null | undefined): number | null {
  if (!stageMs) return null;
  if (typeof stageMs.total === "number") return stageMs.total;
  const vals = Object.values(stageMs).filter((v) => typeof v === "number" && Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}
