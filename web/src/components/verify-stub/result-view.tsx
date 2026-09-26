// STUB (A0) — owner: Codex 2
"use client";

import { Check, CircleDashed, Loader2, Lock, X } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ChallengeResponseOut, VoiceDecision, VoiceOutcome, VoiceResult, VoiceStageLive } from "@/lib/contracts";
import { shortId } from "@/lib/ui";
import { cn } from "@/lib/utils";

const STAGES: { key: VoiceStageLive["stage"]; label: string; metric: string }[] = [
  { key: "transcribing", label: "Words", metric: "WER" },
  { key: "anti-spoof", label: "Synthetic?", metric: "p(spoof)" },
  { key: "speaker", label: "Speaker", metric: "cos" },
  { key: "spectral", label: "Spectral", metric: "sim" },
];

/** Stage row (transcribing → anti-spoof → speaker → spectral) from live voice_stage events, or derived from the result. */
export function StageRow({ stages, result, busy }: { stages: VoiceStageLive[]; result: VoiceResult | null; busy: boolean }) {
  const byKey = new Map(stages.map((s) => [s.stage, s]));
  const derived = (k: VoiceStageLive["stage"]): VoiceStageLive | null => {
    if (!result) return null;
    const v =
      k === "transcribing" ? result.phrase_wer : k === "anti-spoof" ? result.cm_p_spoof : k === "speaker" ? result.asv_cos : result.spec_sim;
    const ok =
      k === "transcribing"
        ? result.decision !== "RETRY"
        : k === "anti-spoof"
          ? result.decision !== "BLOCK_SPOOF"
          : k === "speaker"
            ? result.decision !== "BLOCK_IMPOSTOR"
            : null;
    return { challenge_id: "", stage: k, ok, value: v };
  };
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {STAGES.map((st, i) => {
        const s = byKey.get(st.key) ?? derived(st.key);
        const pending = !s;
        const color = pending ? "var(--muted-foreground)" : s.ok === false ? "var(--trust-suspicious)" : s.ok ? "var(--trust-normal)" : "var(--trust-watch)";
        return (
          <div key={st.key} className="flex items-center gap-2.5 rounded-lg border px-3 py-2" style={{ borderColor: pending ? undefined : `color-mix(in oklch, ${color} 40%, transparent)` }}>
            <span className="grid size-6 shrink-0 place-items-center rounded-full" style={{ background: `color-mix(in oklch, ${color} 16%, transparent)`, color }}>
              {pending ? busy ? <Loader2 className="size-3.5 animate-spin" style={{ animationDelay: `${i * 120}ms` }} /> : <CircleDashed className="size-3.5" /> : s.ok === false ? <X className="size-3.5" /> : <Check className="size-3.5" />}
            </span>
            <div className="min-w-0">
              <div className="text-xs font-medium">{st.label}</div>
              <div className="tnum font-mono text-[11px] text-muted-foreground">
                {st.metric} {s && s.value !== null ? s.value.toFixed(2) : "—"}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const DECISION_STYLE: Record<VoiceDecision, { label: string; color: string }> = {
  VERIFY: { label: "Verified — it's the owner", color: "var(--trust-normal)" },
  RETRY: { label: "Retry — say the new phrase", color: "var(--trust-watch)" },
  FALLBACK_MFA: { label: "Inconclusive — use your authenticator code", color: "var(--trust-watch)" },
  BLOCK_SPOOF: { label: "Blocked — synthetic (cloned) voice", color: "var(--trust-suspicious)" },
  BLOCK_IMPOSTOR: { label: "Blocked — a different speaker", color: "var(--trust-suspicious)" },
};

const f2 = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(2));

export function OutcomeView({ outcome }: { outcome: VoiceOutcome }) {
  return (
    <div className="space-y-3">
      {outcome.resolved_decisions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Held orders resolved:</span>
          {outcome.resolved_decisions.map((d) => (
            <span
              key={d.decision_id}
              className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs"
              style={{ color: d.trans_status === "Y" ? "var(--trust-normal)" : "var(--trust-suspicious)" }}
            >
              <b className="text-sm">{d.trans_status}</b> {d.decision} · {shortId(d.decision_id)}
            </span>
          ))}
        </div>
      )}
      {outcome.device_locked && (
        <div role="alert" className="flex items-center gap-3 rounded-xl border border-trust-suspicious/50 bg-trust-suspicious/12 px-4 py-3">
          <Lock className="size-5 text-trust-suspicious" />
          <div>
            <div className="font-semibold text-trust-suspicious">Device locked</div>
            <div className="text-xs text-muted-foreground">High-risk actions are declined until the owner unlocks with a fresh voice check (or TOTP).</div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ResultView({ res, decisionId, onRetry }: { res: ChallengeResponseOut; decisionId: string | null; onRetry?: () => void }) {
  const r = res.result;
  const st = DECISION_STYLE[r.decision];
  const metrics: [string, string, string][] = [
    ["voice confidence", f2(r.voice_confidence), "fused"],
    ["speaker match", f2(r.asv_cos), "ECAPA cosine"],
    ["synthetic", f2(r.cm_p_spoof), "anti-spoof p(spoof)"],
    ["spectral similarity", f2(r.spec_sim), "vs enrolled LTAS"],
    ["phrase WER", f2(r.phrase_wer), "Scribe"],
    ["onset", r.onset_ms === null ? "—" : `${Math.round(r.onset_ms)} ms`, "after prompt end"],
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge className="h-7 px-3 font-mono text-sm" style={{ background: `color-mix(in oklch, ${st.color} 18%, transparent)`, color: st.color }}>
          {r.decision}
        </Badge>
        <span className="font-medium">{st.label}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {metrics.map(([k, v, hint]) => (
          <div key={k} className="rounded-lg bg-muted/40 px-3 py-2">
            <div className="text-[11px] text-muted-foreground">{k}</div>
            <div className="tnum font-mono text-lg">{v}</div>
            <div className="text-[10px] text-muted-foreground/80">{hint}</div>
          </div>
        ))}
      </div>
      {r.findings.length > 0 && (
        <ul className="space-y-1 text-sm">
          {r.findings.map((f) => (
            <li key={f} className="flex gap-2">
              <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground" />
              {f}
            </li>
          ))}
        </ul>
      )}
      <OutcomeView outcome={res.outcome} />
      <div className="flex flex-wrap gap-2">
        {res.next && onRetry && (
          <Button onClick={onRetry} className={cn("bg-trust-watch text-black hover:bg-trust-watch/85")}>
            Try again (attempt {res.next.attempt})
          </Button>
        )}
        {decisionId && (
          <Button asChild variant="outline">
            <Link href="/shop">Back to the store</Link>
          </Button>
        )}
        <Button asChild variant="ghost">
          <Link href="/dashboard">Dashboard</Link>
        </Button>
      </div>
    </div>
  );
}
