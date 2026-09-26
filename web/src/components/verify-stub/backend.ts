// STUB (A0) — owner: Codex 2
// /verify data access: the real REST API, or (mock mode) canned responses that also push voice_stage
// events into the mock live stream so the stage row animates.
import { api } from "@/lib/api";
import type { ChallengeOut, ChallengeResponseOut, TotpVerifyOut, VoiceDecision, VoiceResult } from "@/lib/contracts";
import { getLiveStore } from "@/lib/live";
import { MOCK_DEVICE_ID, mockFeedEvent } from "@/lib/live-mock";

export const FAKE_DECISIONS: VoiceDecision[] = ["VERIFY", "RETRY", "FALLBACK_MFA", "BLOCK_SPOOF", "BLOCK_IMPOSTOR"];

export interface VerifyBackend {
  mock: boolean;
  getChallenge(id: string): Promise<ChallengeOut>;
  promptUrl(ch: ChallengeOut): string | null;
  promptEnded(id: string): Promise<void>;
  respond(id: string, wav: Blob, promptEndMs: number, fake: VoiceDecision | null, decisionId: string | null): Promise<ChallengeResponseOut>;
  totp(id: string, code: string, decisionId: string | null): Promise<TotpVerifyOut>;
  createUnlock(): Promise<ChallengeOut>;
}

export const realBackend: VerifyBackend = {
  mock: false,
  getChallenge: (id) => api.challenge(id),
  promptUrl: (ch) => (ch.prompt_url ? ch.prompt_url : api.promptUrl(ch.challenge_id)),
  promptEnded: async (id) => {
    await api.promptEnded(id);
  },
  respond: (id, wav, ms, fake) => api.challengeResponse(id, wav, ms, fake ?? undefined),
  totp: (id, code) => api.totpVerify(id, code),
  createUnlock: () => api.createChallenge("unlock"),
};

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

const PHRASES = ["violet river seven lanterns", "copper meadow after midnight", "eleven quiet harbor lights"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();

const CANNED: Record<VoiceDecision, Omit<VoiceResult, "decision" | "spectrogram">> = {
  VERIFY: { voice_confidence: 0.96, asv_cos: 0.81, cm_p_spoof: 0.04, spec_sim: 0.92, phrase_wer: 0, onset_ms: 380, dsp: { hnr_db: 17.2, jitter_pct: 0.74 }, findings: [], stage_ms: { stt: 610, cm: 400, asv: 210, dsp: 85 } },
  RETRY: { voice_confidence: 0.5, asv_cos: 0.52, cm_p_spoof: 0.38, spec_sim: 0.8, phrase_wer: 0.5, onset_ms: 900, dsp: {}, findings: ["Phrase not recognized clearly — please repeat"], stage_ms: { stt: 600 } },
  FALLBACK_MFA: { voice_confidence: 0.45, asv_cos: 0.44, cm_p_spoof: 0.41, spec_sim: 0.77, phrase_wer: 0.1, onset_ms: 520, dsp: {}, findings: ["Gray zone after retries — use your authenticator code"], stage_ms: { stt: 600, cm: 400, asv: 210 } },
  BLOCK_SPOOF: { voice_confidence: 0.07, asv_cos: 0.58, cm_p_spoof: 0.93, spec_sim: 0.71, phrase_wer: 0, onset_ms: 212, dsp: { hnr_db: 21.4, jitter_pct: 0.31 }, findings: ["High-band energy above 7 kHz is missing (vocoder band-limit)", "Pitch jitter unusually low for live speech"], stage_ms: { stt: 640, cm: 410, asv: 220, dsp: 90 } },
  BLOCK_IMPOSTOR: { voice_confidence: 0.06, asv_cos: 0.21, cm_p_spoof: 0.05, spec_sim: 0.62, phrase_wer: 0, onset_ms: 450, dsp: {}, findings: ["Speaker embedding far from the enrolled owner"], stage_ms: { stt: 600, cm: 400, asv: 210, dsp: 85 } },
};

const FAIL_STAGE: Partial<Record<VoiceDecision, string>> = { BLOCK_SPOOF: "anti-spoof", BLOCK_IMPOSTOR: "speaker", RETRY: "transcribing" };
const STAGE_VALUE: Record<string, (d: VoiceDecision) => number | null> = {
  transcribing: (d) => CANNED[d].phrase_wer,
  "anti-spoof": (d) => CANNED[d].cm_p_spoof,
  speaker: (d) => CANNED[d].asv_cos,
  spectral: (d) => CANNED[d].spec_sim,
};

const attempts = new Map<string, number>();

/** Mock: resolve a held order in the simulated stream (what the server's voice_decided does). */
function resolveInStream(decisionId: string | null, allow: boolean) {
  if (!decisionId) return;
  const store = getLiveStore(true);
  const held = store.getSnapshot().decisions.find((d) => d.decision_id === decisionId);
  if (!held) return;
  const { t: _t, ...rest } = held;
  void _t;
  store.dispatch({
    type: "decision",
    device_id: MOCK_DEVICE_ID,
    t: iso(Date.now()),
    data: { ...rest, status: "final", decision: allow ? "allow" : "block", trans_status: allow ? "Y" : "N", reasons: [...rest.reasons, allow ? "voice_verified" : "voice_blocked"] },
  });
  store.dispatch(mockFeedEvent("decision", allow ? "Held order resolved → Y approved after voice check" : "Held order resolved → N declined", allow ? 1 : 4));
}

function mockChallenge(id: string, trigger: ChallengeOut["trigger"] = "proactive"): ChallengeOut {
  const attempt = attempts.get(id) ?? 1;
  return {
    challenge_id: id,
    trigger,
    status: "issued",
    attempt,
    phrase: PHRASES[(attempt - 1) % PHRASES.length],
    prompt_url: "",
    expires_at: iso(Date.now() + 120_000),
    verify_url: `/verify?c=${id}`,
  };
}

export const mockBackend: VerifyBackend = {
  mock: true,
  async getChallenge(id) {
    await sleep(250);
    const open = getLiveStore(true).getSnapshot().open_challenge;
    return mockChallenge(id, open?.challenge_id === id ? open.trigger : id.includes("unlock") ? "unlock" : "proactive");
  },
  promptUrl: () => null, // mock plays a synthetic beep
  async promptEnded() {
    await sleep(50);
  },
  async respond(id, _wav, _ms, fake, decisionId) {
    const d: VoiceDecision = fake ?? "VERIFY";
    const store = getLiveStore(true);
    const stage = (s: "transcribing" | "anti-spoof" | "speaker" | "spectral" | "done", ok: boolean | null, value: number | null) =>
      store.dispatch({ type: "voice_stage", device_id: MOCK_DEVICE_ID, t: iso(Date.now()), data: { challenge_id: id, stage: s, ok, value } });
    await sleep(300);
    for (const s of ["transcribing", "anti-spoof", "speaker", "spectral"] as const) {
      stage(s, FAIL_STAGE[d] !== s, STAGE_VALUE[s](d));
      await sleep(450);
    }
    stage("done", d === "VERIFY", null);
    const attempt = attempts.get(id) ?? 1;
    const blocked = d === "BLOCK_SPOOF" || d === "BLOCK_IMPOSTOR";
    if (d === "VERIFY" || blocked) resolveInStream(decisionId, d === "VERIFY");
    let next: ChallengeResponseOut["next"] = null;
    if (d === "RETRY") {
      attempts.set(id, attempt + 1);
      next = { phrase: PHRASES[attempt % PHRASES.length], prompt_url: "", expires_at: iso(Date.now() + 120_000), attempt: attempt + 1 };
    }
    return {
      result: { decision: d, ...CANNED[d], spectrogram: null },
      outcome: {
        device_locked: blocked,
        resolved_decisions:
          decisionId && (d === "VERIFY" || blocked)
            ? [{ decision_id: decisionId, decision: d === "VERIFY" ? "allow" : "block", trans_status: d === "VERIFY" ? "Y" : "N" }]
            : [],
      },
      next,
    };
  },
  async totp(_id, code, decisionId) {
    await sleep(400);
    const ok = code === "123456";
    resolveInStream(decisionId, ok);
    return {
      ok,
      outcome: {
        device_locked: !ok,
        resolved_decisions: decisionId ? [{ decision_id: decisionId, decision: ok ? "allow" : "block", trans_status: ok ? "Y" : "N" }] : [],
      },
    };
  },
  async createUnlock() {
    await sleep(250);
    return mockChallenge(`mock-unlock-${Math.random().toString(16).slice(2, 10)}`, "unlock");
  },
};
