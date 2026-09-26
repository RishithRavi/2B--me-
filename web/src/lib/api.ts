// Typed client for the REST API in contracts/api.md. Same-origin (/api), cookie auth, JSON in/out.
// Every function maps 1:1 to an endpoint; shapes come from the generated contracts.ts.
import type {
  AdminActionIn,
  AnomalyRow,
  AuditRow,
  BaselineOut,
  ChallengeCreateIn,
  ChallengeOut,
  ChallengeResponseOut,
  CheckoutIn,
  DecisionDetailOut,
  DecisionIn,
  DecisionOut,
  DemoLabelIn,
  DemoMarkerIn,
  DeviceOut,
  DeviceRegisterIn,
  DeviceRegisterOut,
  DriftRow,
  EnrollProgress,
  EvalReport,
  HearsayReport,
  JobOut,
  MeOut,
  Modality,
  Mode,
  ModelInfo,
  OkOut,
  OrgSeedOut,
  PresenceIn,
  PresenceOut,
  RedteamActiveOut,
  RedteamReport,
  RosterRow,
  SessionRow,
  StatusOut,
  TigerStats,
  TotpEnrollOut,
  TotpVerifyOut,
  TrustSeries,
  VoiceEnrollOut,
  VoiceDecision,
  VoiceEnrollStartOut,
} from "./contracts";

/** Base URL for REST. Empty origin = same-origin (production: https://2bme.tech/api; dev: Next rewrite). */
export const API_BASE = `${process.env.NEXT_PUBLIC_API_ORIGIN ?? ""}/api`;

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(`${status}: ${detail}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
  /** Network failure / API down (no HTTP response at all). */
  get offline(): boolean {
    return this.status === 0;
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

function qs(q?: Query): string {
  if (!q) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === null || v === undefined || v === "") continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

async function parseDetail(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "detail" in body) {
      const d = (body as { detail: unknown }).detail;
      if (typeof d === "string") return d;
      return JSON.stringify(d);
    }
    return JSON.stringify(body);
  } catch {
    return res.statusText || "request failed";
  }
}

interface RequestOpts {
  query?: Query;
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function request<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}${qs(opts.query)}`, {
      method,
      headers,
      body,
      credentials: "include",
      cache: "no-store",
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "API offline");
  }
  if (!res.ok) throw new ApiError(res.status, await parseDetail(res));
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) return (await res.text()) as unknown as T;
  return (await res.json()) as T;
}

const get = <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>("GET", path, { query, signal });
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, { body: body ?? {} });

export type ReportKind = "eval" | "redteam" | "hearsay";
export interface ReportByKind {
  eval: EvalReport;
  redteam: RedteamReport;
  hearsay: HearsayReport;
}

export interface HistoryTrustQuery {
  session_id?: string | null;
  from?: string | null;
  to?: string | null;
  bucket?: string | null;
}

export const api = {
  // ---- auth ----
  login: (email: string, password: string) => post<MeOut>("/auth/login", { email, password }),
  logout: () => post<OkOut>("/auth/logout"),
  me: (signal?: AbortSignal) => get<MeOut>("/me", undefined, signal),

  // ---- devices / presence ----
  registerDevice: (body: DeviceRegisterIn = {}) => post<DeviceRegisterOut>("/devices/register", body),
  devices: () => get<DeviceOut[]>("/devices"),
  presence: (body: PresenceIn) => post<PresenceOut>("/web/presence", body),

  // ---- enroll / models ----
  setMode: (device_id: string, mode: Mode) => post<OkOut>("/enroll/mode", { device_id, mode }),
  enrollStatus: (device_id: string) => get<EnrollProgress>("/enroll/status", { device_id }),
  train: (device_id: string, source: "tiger" | "logs" = "tiger") => post<JobOut>("/enroll/train", { device_id, source }),
  retrain: (device_id: string) => post<JobOut>("/models/retrain", { device_id }),
  activeModel: (user_id?: string) => get<ModelInfo>("/models/active", { user_id }),
  modelHistory: (user_id?: string) => get<ModelInfo[]>("/models/history", { user_id }),

  // ---- decisions ----
  decide: (body: DecisionIn) => post<DecisionOut>("/decisions", body),
  authorizeCheckout: (body: CheckoutIn) => post<DecisionOut>("/checkout/authorize", body),
  decision: (id: string) => get<DecisionDetailOut>(`/decisions/${encodeURIComponent(id)}`),

  // ---- voice (server side owned by Codex 2) ----
  voiceEnrollStart: () => post<VoiceEnrollStartOut>("/voice/enroll/start"),
  voiceEnroll: (enroll_id: string, wavs: Blob[]) => {
    const form = new FormData();
    form.set("enroll_id", enroll_id);
    wavs.forEach((w, i) => form.append("wav", w, `utt_${i}.wav`));
    return request<VoiceEnrollOut>("POST", "/voice/enroll", { form });
  },
  createChallenge: (reason: ChallengeCreateIn["reason"]) => post<ChallengeOut>("/voice/challenges", { reason }),
  challenge: (id: string) => get<ChallengeOut>(`/voice/challenges/${encodeURIComponent(id)}`),
  /** URL for <audio src>; the first GET starts the 30 s TTL. */
  promptUrl: (id: string) => `${API_BASE}/voice/challenges/${encodeURIComponent(id)}/prompt.mp3`,
  promptEnded: (id: string) => post<OkOut>(`/voice/challenges/${encodeURIComponent(id)}/prompt-ended`),
  challengeResponse: (id: string, wav: Blob, client_prompt_end_ms: number, fakeDecision?: string) => {
    const form = new FormData();
    form.set("wav", wav, "response.wav");
    form.set("client_prompt_end_ms", String(Math.round(client_prompt_end_ms)));
    return request<ChallengeResponseOut>("POST", `/voice/challenges/${encodeURIComponent(id)}/response`, {
      form,
      headers: fakeDecision ? { "X-Fake-Decision": fakeDecision } : undefined,
    });
  },
  totpVerify: (challenge_id: string, code: string) => post<TotpVerifyOut>("/voice/totp/verify", { challenge_id, code }),
  totpEnroll: () => post<TotpEnrollOut>("/voice/totp/enroll"),

  // ---- history (Tiger) ----
  historySessions: (limit = 50, signal?: AbortSignal) => get<SessionRow[]>("/history/sessions", { limit }, signal),
  historyTrust: (q: HistoryTrustQuery, signal?: AbortSignal) => get<TrustSeries>("/history/trust", { ...q }, signal),
  historyAnomalies: (limit = 50, signal?: AbortSignal) => get<AnomalyRow[]>("/history/anomalies", { limit }, signal),
  historyBaseline: (modality: Modality, session_id?: string | null, signal?: AbortSignal) =>
    get<BaselineOut>("/history/baseline", { modality, session_id }, signal),
  historyDrift: () => get<DriftRow[]>("/history/drift"),
  tigerStats: (signal?: AbortSignal) => get<TigerStats>("/tiger/stats", undefined, signal),
  compressNow: () => post<OkOut>("/tiger/compress-now"),

  // ---- reports ----
  evalReport: <K extends ReportKind>(kind: K, signal?: AbortSignal) =>
    get<ReportByKind[K]>("/eval/report", { kind }, signal),

  // ---- demo / admin ----
  demoLabel: (body: DemoLabelIn) => post<OkOut>("/demo/label", body),
  demoMarker: (body: DemoMarkerIn) => post<OkOut>("/demo/marker", body),
  demoReset: (device_id: string) => post<OkOut>("/demo/reset", { device_id }),
  demoRearm: (device_id: string, confidence = 0.31) => post<OkOut>("/demo/rearm", { device_id, confidence }),
  purgeSession: (session_id: string) => post<OkOut>("/demo/purge-session", { session_id }),
  redteamActive: (device_id: string) =>
    get<RedteamActiveOut | null>("/demo/redteam/active-challenge", { device_id }),
  /** Stub voice only: pick the next outcome for this device's challenges (null clears). Results are flagged simulated. */
  demoVoiceOutcome: (device_id: string, decision: VoiceDecision | null) =>
    post<OkOut>("/demo/voice-outcome", { device_id, decision }),
  demoOrgSeed: (n = 19) => post<OrgSeedOut>("/demo/org/seed", { n }),

  // ---- admin / org panel (§2.4) ----
  adminRoster: (signal?: AbortSignal) => get<RosterRow[]>("/admin/roster", undefined, signal),
  adminAudit: (limit = 100, device_id?: string | null, signal?: AbortSignal) =>
    get<AuditRow[]>("/admin/audit", { limit, device_id }, signal),
  adminAction: (body: AdminActionIn) => post<AuditRow>("/admin/actions", body),

  // ---- health ----
  status: (signal?: AbortSignal) => get<StatusOut>("/status", undefined, signal),
  healthz: () => get<{ ok: boolean }>("/healthz"),
};

export type Api = typeof api;

/** Short human message for a thrown error (toasts). */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.offline) return "API offline";
    if (e.status === 401) return "Not signed in";
    if (e.status === 403) return "Not allowed (admin only?)";
    return e.detail || `HTTP ${e.status}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
