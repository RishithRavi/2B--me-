// STUB (A0) — owner: Codex 2
// Checkout for the /shop stub: POST /api/checkout/authorize, or (mock mode) the same §5.4 policy evaluated
// against the simulated live confidence, pushed into the mock stream as a `decision` event.
import { api } from "@/lib/api";
import { TRUST_CONFIG, type DecisionDetailOut, type DecisionLive, type DecisionOut, type Tier } from "@/lib/contracts";
import { getLiveStore } from "@/lib/live";
import { MOCK_DEVICE_ID, mockFeedEvent } from "@/lib/live-mock";

export const AMOUNT_CENTS = 200_000;
export const TEST_PAN = "4111 1111 1111 1111";
export const CARD_LAST4 = "1111";

/** Policy tier for a purchase amount (§5.4): R1 < $100, R2 < $500, else R3. */
export function purchaseTier(cents: number): Tier {
  const t = TRUST_CONFIG.policy.tiers;
  if (cents < t.R1.purchase_below_cents) return "R1";
  if (cents < t.R2.purchase_below_cents) return "R2";
  return "R3";
}

export async function authorize(mock: boolean): Promise<DecisionOut> {
  if (!mock) return api.authorizeCheckout({ amount_cents: AMOUNT_CENTS, card_last4: CARD_LAST4 });

  await new Promise((r) => setTimeout(r, 450));
  const store = getLiveStore(true);
  const s = store.getSnapshot();
  const conf = s.trust?.confidence ?? TRUST_CONFIG.anchors.remote;
  const tier = purchaseTier(AMOUNT_CENTS);
  const min = TRUST_CONFIG.policy.tiers[tier].min_conf;
  const locked = Boolean(s.device?.locked || s.trust?.locked);
  const id = `mock-dec-${Math.random().toString(16).slice(2, 10)}`;
  const challenge = locked || conf >= min ? null : (s.open_challenge?.challenge_id ?? `mock-ch-${Math.random().toString(16).slice(2, 10)}`);
  const out: DecisionLive = {
    decision_id: id,
    status: challenge ? "pending" : "final",
    decision: locked ? "block" : challenge ? "step_up" : "allow",
    trans_status: locked ? "N" : challenge ? "C" : "Y",
    confidence: conf,
    tier,
    binding: s.presence?.binding ?? "co-present",
    reasons: locked ? ["device_locked"] : [`confidence ${conf.toFixed(2)} ${conf >= min ? "≥" : "<"} ${min.toFixed(2)} (${tier})`],
    challenge_id: challenge,
    verify_url: challenge ? `/verify?c=${challenge}&d=${id}` : null,
    action: "purchase",
    amount_cents: AMOUNT_CENTS,
  };
  store.dispatch({ type: "decision", device_id: MOCK_DEVICE_ID, t: new Date().toISOString(), data: out });
  const verb = out.trans_status === "Y" ? "approved" : out.trans_status === "C" ? "step-up" : "declined";
  store.dispatch(
    mockFeedEvent("decision", `Purchase $2,000.00 → ${out.trans_status} ${verb} at ${Math.round(conf * 100)}% · ${tier} · ${out.binding}`, out.trans_status === "Y" ? 0 : out.trans_status === "C" ? 2 : 4),
  );
  return out;
}

export async function refreshDecision(id: string, mock: boolean): Promise<DecisionDetailOut | null> {
  if (mock) return null;
  try {
    return await api.decision(id);
  } catch {
    return null;
  }
}

// Last decision survives the round-trip to /verify (sessionStorage; per tab).
const KEY = "2bme:shop:last";
export function saveLast(d: DecisionOut) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* private mode */
  }
}
export function loadLast(): DecisionOut | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DecisionOut) : null;
  } catch {
    return null;
  }
}
export function clearLast() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
