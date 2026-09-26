"use client";
import { useEffect, useRef, useState } from "react";
import { ShoppingBag } from "lucide-react";
import { PageHeader } from "@/components/site/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ChallengeFlow } from "@/components/voice/challenge-flow";
import { resolveCheckout } from "@/components/voice/checkout-result";
import { api, errorMessage } from "@/lib/api";
import type { DecisionOut, VoiceOutcome } from "@/lib/contracts";
import { useLive } from "@/lib/live";
import { useMe } from "@/lib/session";
import { useNow } from "@/lib/hooks";

export default function ShopPage() {
  const { me } = useMe();
  const { state, connected } = useLive({ mock: false });
  const now = useNow();
  const [decision, setDecision] = useState<DecisionOut | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const device = me?.device;
  const matching = !!device && state.device?.id === device.id;
  const age = matching && state.health?.heartbeat_age_s != null && state.healthAt != null
    ? state.health.heartbeat_age_s + (now - state.healthAt) / 1000
    : device?.last_seen ? (now - Date.parse(device.last_seen)) / 1000 : null;
  const bound = matching && connected && age !== null && age >= 0 && age < 30 && state.presence?.binding === "co-present";
  const confidence = bound ? state.trust?.confidence : null;

  // An order can expire or finish in /verify while its dialog is closed.
  useEffect(() => {
    if (!decision || decision.status !== "pending") return;
    const id = decision.decision_id;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const latest = await api.decision(id);
        if (!cancelled && latest.status === "final") {
          setDecision((current) => current?.decision_id === id && current.status === "pending"
            ? { ...latest, decision: latest.final_decision ?? latest.decision,
                trans_status: latest.final_trans_status ?? latest.trans_status } : current);
          return;
        }
      } catch { /* A temporary disconnect must not approve or decline an order. */ }
      if (!cancelled) timer = setTimeout(() => void refresh(), 3000);
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [decision?.decision_id, decision?.status]);

  async function pay() {
    if (submitting.current || decision?.status === "pending") return;
    submitting.current = true; setBusy(true); setError("");
    try {
      const result = await api.authorizeCheckout({ amount_cents: 200000, card_last4: "1111" });
      setDecision(result);
      if (result.trans_status === "C" && result.challenge_id) { setChallenge(result.challenge_id); setOpen(true); }
    } catch (e) { setError(errorMessage(e)); }
    finally { submitting.current = false; setBusy(false); }
  }
  function resolved(outcome: VoiceOutcome) { setDecision((current) => resolveCheckout(current, outcome)); }

  return <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
    <p className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm font-medium">DEMO – no real payment, not affiliated with Visa</p>
    <PageHeader eyebrow="2bME Demo Store" title="A purchase that knows it’s you">A $2,000 demo purchase uses continuous trust and a voice or MFA step-up when needed.</PageHeader>
    <div className="grid gap-6 md:grid-cols-[1.2fr_1fr]">
      <section className="panel space-y-5 p-6">
        <div className="flex items-center gap-4 rounded-xl bg-muted p-5"><ShoppingBag className="size-12" aria-hidden /><div><h2 className="font-semibold">Studio travel collection</h2><p className="text-sm text-muted-foreground">One demo item · $2,000.00</p></div></div>
        <label className="block space-y-1 text-sm">Test card number<Input readOnly value="4111 1111 1111 1111" aria-label="Read-only test card number" /></label>
        <div className={`rounded-xl border p-4 text-sm ${bound ? "border-emerald-500/50" : "border-red-500/50 text-red-500"}`}>
          <p>{device?.label ?? "No bound device"} · {age === null ? "No heartbeat" : `${Math.max(0, Math.floor(age))}s since heartbeat`}</p>
          <p>{bound ? "Co-present" : "Remote or stale binding"} · {confidence == null ? "Remote session prior: 30%" : `Live confidence: ${Math.round(confidence * 100)}%`}</p>
        </div>
        <div className="flex items-center justify-between border-t pt-4"><span>Total</span><strong className="text-xl">$2,000.00</strong></div>
        <Button className="w-full" disabled={busy || decision?.status === "pending"} onClick={() => void pay()}>{busy ? "Authorizing…" : "Pay $2,000 (demo)"}</Button>
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
        {decision && <div className="space-y-2 rounded-xl border p-4" role="status">
          <p className="font-semibold">3-D Secure-style result: {decision.trans_status} (simulated)</p>
          <p>{decision.trans_status === "Y" ? "Approved" : decision.trans_status === "C" ? "Verification required" : "Declined"}</p>
          <p className="text-sm">{Math.round(decision.confidence * 100)}% at authorization · {decision.binding} · {decision.tier}</p>
          <ul className="text-sm text-muted-foreground">{decision.reasons?.map((reason) => <li key={reason}>{reason.replaceAll("_", " ")}</li>)}</ul>
          {decision.trans_status === "C" && challenge && <Button variant="outline" onClick={() => setOpen(true)}>Continue verification</Button>}
        </div>}
      </section>
      <aside className="panel h-fit space-y-4 p-6"><h2 className="font-semibold">When we ask for verification</h2>
        <table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="py-2">Tier</th><th>Action</th><th>Trust</th></tr></thead>
          <tbody>{[["R0", "View", "40%"], ["R1", "Purchase under $100", "60%"], ["R2", "$100–499 or export", "80%"], ["R3", "$500+ or account changes", "90%"]].map(([tier, action, value]) =>
            <tr className="border-b" key={tier}><td className="py-3 font-mono">{tier}</td><td>{action}</td><td>{value}</td></tr>)}</tbody></table>
        <p className="text-sm text-muted-foreground">Below the threshold, we request a step-up. Behavioral signals alone never decline a purchase. A device lock returns N.</p>
      </aside>
    </div>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>Verify this purchase</DialogTitle><DialogDescription>Read the fresh phrase using your demo microphone. The server resolves this order.</DialogDescription></DialogHeader>
      {challenge && <ChallengeFlow key={challenge} challengeId={challenge} onDone={({ outcome }) => resolved(outcome)} onMfaDone={resolved} />}
    </DialogContent></Dialog>
  </div>;
}
