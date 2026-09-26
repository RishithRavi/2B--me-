// STUB (A0) — owner: Codex 2
"use client";

import { CreditCard, Laptop, Loader2, Lock, ShieldAlert, ShoppingBag } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { PageHeader } from "@/components/site/empty-state";
import { AMOUNT_CENTS, TEST_PAN, authorize, clearLast, loadLast, purchaseTier, refreshDecision, saveLast } from "@/components/shop-stub/backend";
import { BindingBadge, ResultCard, TierMatrix } from "@/components/shop-stub/parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import type { DecisionDetailOut, DecisionOut } from "@/lib/contracts";
import { useNow } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { useMockMode } from "@/lib/mode";
import { useMe } from "@/lib/session";
import { fmtMoney } from "@/lib/ui";

function payError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.offline) return "Can't reach the 2bME API.";
    if (e.status === 401) return "Sign in to check out.";
    return e.detail || `HTTP ${e.status}`;
  }
  return String(e);
}

export default function ShopPage() {
  const mock = useMockMode();
  const me = useMe();
  const { state } = useLive({ enabled: me.status === "ok" || me.status === "offline" });
  const now = useNow(1000);
  const [decision, setDecision] = useState<DecisionOut | null>(null);
  const [detail, setDetail] = useState<DecisionDetailOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore the last order after a round-trip to /verify, and fetch its final status.
  useEffect(() => {
    const last = loadLast();
    if (!last) return;
    setDecision(last);
    void refreshDecision(last.decision_id, mock).then((d) => d && setDetail(d));
  }, [mock]);

  // Live `decision` events for this order (e.g. resolved by a voice VERIFY / BLOCK) update the card in place.
  const liveDecision = useMemo(
    () => (decision ? state.decisions.find((d) => d.decision_id === decision.decision_id) : undefined),
    [decision, state.decisions],
  );
  const shown: DecisionOut | null = decision ? { ...decision, ...(liveDecision ?? {}) } : null;

  async function pay() {
    setBusy(true);
    setError(null);
    setDetail(null);
    try {
      const d = await authorize(mock);
      setDecision(d);
      saveLast(d);
    } catch (e) {
      setError(payError(e));
    } finally {
      setBusy(false);
    }
  }

  const tier = shown?.tier ?? purchaseTier(AMOUNT_CENTS);
  const locked = Boolean(state.device?.locked || state.trust?.locked);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <div role="note" className="mb-6 flex items-center gap-2.5 rounded-lg border border-trust-watch/45 bg-trust-watch/10 px-4 py-2.5 text-sm font-medium text-trust-watch">
        <ShieldAlert className="size-4 shrink-0" />
        DEMO – no real payment, not affiliated with Visa
      </div>

      <PageHeader eyebrow="2bME Demo Store" title="Checkout">
        The order is authorized by live behavioral confidence, not by the fact that you&apos;re logged in.
      </PageHeader>

      <div className="grid gap-5 lg:grid-cols-12">
        <div className="space-y-5 lg:col-span-7">
          {/* the one item */}
          <div className="panel flex gap-5 p-5">
            <div className="grid size-28 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand/25 to-brand-2/25 ring-1 ring-foreground/10">
              <Laptop className="size-12 text-foreground/80" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-lg font-semibold">Field Workstation 16″</div>
              <p className="mt-1 text-sm text-muted-foreground">
                The demo&apos;s high-risk purchase: a policy tier R3 action that needs ≥ 90% behavioral confidence to go through without friction.
              </p>
              <div className="tnum mt-3 text-2xl font-semibold">{fmtMoney(AMOUNT_CENTS)}</div>
            </div>
          </div>

          {/* card form (read-only test data) */}
          <div className="panel space-y-4 p-5">
            <div className="flex items-center gap-2">
              <CreditCard className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">Payment</h2>
              <span className="ml-auto text-[11px] text-muted-foreground">test card · read-only</span>
            </div>
            <BindingBadge state={state} now={now} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="pan">Card number</Label>
                <Input id="pan" value={TEST_PAN} readOnly className="tnum font-mono tracking-wider" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="exp">Expiry</Label>
                <Input id="exp" value="12 / 29" readOnly className="tnum font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cvc">CVC</Label>
                <Input id="cvc" value="•••" readOnly className="font-mono" />
              </div>
            </div>
            {error && (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}{" "}
                {error.startsWith("Sign in") && (
                  <Link href="/login" className="underline underline-offset-4">
                    Log in
                  </Link>
                )}
              </p>
            )}
            <Button className="h-11 w-full text-base" onClick={() => void pay()} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : locked ? <Lock /> : <ShoppingBag />}
              Pay {fmtMoney(AMOUNT_CENTS)}
            </Button>
            {decision && (
              <button
                type="button"
                className="block w-full text-center text-xs text-muted-foreground underline-offset-4 hover:underline"
                onClick={() => {
                  clearLast();
                  setDecision(null);
                  setDetail(null);
                }}
              >
                Clear result
              </button>
            )}
          </div>
        </div>

        <div className="space-y-5 lg:col-span-5">
          {shown ? (
            <ResultCard decision={shown} detail={detail} wasStepUp={decision?.trans_status === "C" && shown.trans_status !== "C"} />
          ) : (
            <div className="panel px-5 py-8 text-center text-sm text-muted-foreground">
              Press Pay to see the 3-D Secure-style result (Y / C / N, simulated).
            </div>
          )}
          <div className="panel p-5">
            <h2 className="mb-2 text-sm font-medium">Tier × confidence</h2>
            <TierMatrix confidence={state.trust?.confidence ?? null} activeTier={tier} locked={locked} />
          </div>
        </div>
      </div>
    </div>
  );
}
