import { ArrowRight, Building2, Laptop, Lock, Mic, ShieldAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { LogoMark } from "@/components/site/logo";
import { Button } from "@/components/ui/button";
import type { Level } from "@/lib/contracts";
import { levelColor, levelFromConfidence, levelLabel } from "@/lib/ui";
import { cn } from "@/lib/utils";

// Static, illustrative mockups of the two product surfaces (not live data; labelled as such).

function Screen({ children, className, tone = "desk" }: { children: ReactNode; className?: string; tone?: "desk" | "dim" | "lock" }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-muted/30 shadow-lg shadow-black/20">
      <div className="flex h-4 items-center gap-1 border-b bg-muted/60 px-1.5">
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <span key={c} className="size-1.5 rounded-full" style={{ background: c, opacity: 0.8 }} />
        ))}
      </div>
      <div
        className={cn("relative aspect-[16/10]", className)}
        style={{
          background:
            tone === "lock"
              ? "#06070a"
              : "linear-gradient(135deg, color-mix(in oklch, var(--brand-2) 16%, var(--card)), color-mix(in oklch, var(--brand) 10%, var(--card)))",
        }}
      >
        {tone !== "lock" && (
          // a faint "app window" so the overlay reads as sitting on top of someone's work
          <div className="absolute inset-x-[8%] top-[14%] bottom-[10%] rounded-md border border-foreground/10 bg-background/55 p-[4%]">
            <div className="h-[7%] w-1/3 rounded-sm bg-foreground/10" />
            <div className="mt-[4%] space-y-[3%]">
              {[82, 64, 74, 40, 58].map((w) => (
                <div key={w} className="h-[5%] min-h-1 rounded-sm bg-foreground/8" style={{ width: `${w}%` }} />
              ))}
            </div>
          </div>
        )}
        {tone === "dim" && <div className="absolute inset-0 bg-black/60 backdrop-blur-[1px]" />}
        {children}
      </div>
    </div>
  );
}

function MiniPill() {
  const pts = [0.97, 0.98, 0.97, 0.99, 0.98, 0.97, 0.98, 0.99, 0.98, 0.97, 0.98, 0.98];
  const line = pts.map((c, i) => `${(i / (pts.length - 1)) * 44 + 1},${15 - c * 13}`).join(" ");
  return (
    <div className="absolute top-[6%] right-[4%] flex items-center gap-1.5 rounded-lg border bg-background/95 px-1.5 py-1 shadow-lg">
      <LogoMark className="size-3.5" />
      <div className="leading-none">
        <div className="tnum text-[11px] font-semibold text-trust-normal">97%</div>
        <div className="text-[6px] tracking-wider text-muted-foreground uppercase">normal</div>
      </div>
      <svg width="46" height="16" viewBox="0 0 46 16" aria-hidden>
        <polyline points={line} fill="none" stroke="var(--trust-normal)" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function MiniPrompt() {
  return (
    <div className="absolute inset-0 grid place-items-center p-[6%]">
      <div className="w-[78%] rounded-lg border bg-card/95 p-2.5 shadow-xl">
        <div className="flex items-center gap-1.5">
          <ShieldAlert className="size-3 text-trust-suspicious" />
          <span className="text-[10px] font-semibold">Is this still the owner?</span>
        </div>
        <p className="mt-1 text-[7px] leading-snug text-muted-foreground">Typing and pointer rhythm stopped matching (trust 18%). Answer a quick voice check to continue.</p>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {["flight time +3.1σ", "path curvature +2.8σ"].map((c) => (
            <span key={c} className="rounded-full bg-trust-suspicious/15 px-1.5 text-[6px] text-trust-suspicious">
              {c}
            </span>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="inline-flex items-center gap-1 rounded-md bg-primary px-1.5 py-0.5 text-[7px] font-medium text-primary-foreground">
            <Mic className="size-2" /> Start voice check
          </span>
          <span className="text-[7px] text-muted-foreground">Not now</span>
        </div>
      </div>
    </div>
  );
}

function MiniLock() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-center">
      <div className="grid size-7 place-items-center rounded-lg border border-trust-locked/40 bg-trust-locked/15">
        <Lock className="size-3.5 text-trust-locked" />
      </div>
      <div className="text-[11px] font-semibold text-white">This Mac is locked</div>
      <div className="max-w-[70%] text-[7px] leading-snug text-white/60">A cloned voice answered the check. The session was signed out.</div>
      <span className="mt-0.5 inline-flex items-center gap-1 rounded-md bg-white px-1.5 py-0.5 text-[7px] font-medium text-black">
        <Mic className="size-2" /> Unlock with voice
      </span>
    </div>
  );
}

const FRAMES = [
  { key: "pill", title: "Always-on trust pill", body: "Sits on top of every app and shows live trust.", screen: <Screen><MiniPill /></Screen> },
  {
    key: "prompt",
    title: "Step-up takes over",
    body: "Trust under 40%: a full-screen voice check, with a one-time code as fallback. “Not now” is allowed; behavior alone never blocks.",
    screen: (
      <Screen tone="dim">
        <MiniPrompt />
      </Screen>
    ),
  },
  {
    key: "lock",
    title: "Failed check locks",
    body: "The session is signed out and the screen stays locked until the owner unlocks with a fresh phrase.",
    screen: (
      <Screen tone="lock">
        <MiniLock />
      </Screen>
    ),
  },
];

type Row = { who: string; team: string; pct: number; locked?: boolean; alert: string };
// Synthetic, anonymized employees (illustration only). Level is derived from the displayed %, never stored.
const ROSTER: Row[] = [
  { who: "Employee 12", team: "Finance", pct: 31, alert: "takeover suspected · 2 min ago" },
  { who: "Employee 07", team: "Support", pct: 0, locked: true, alert: "cloned voice blocked · 6 min ago" },
  { who: "Employee 03", team: "Sales", pct: 64, alert: "unusual app switching · 21 min ago" },
  { who: "Employee 18", team: "Engineering", pct: 97, alert: "none today" },
  { who: "Employee 01", team: "Finance", pct: 98, alert: "none today" },
  { who: "Employee 15", team: "Ops", pct: 95, alert: "none today" },
];

const AUDIT = [
  ["19:42:10", "Employee 12", "trust 96% → 31%, challenge armed"],
  ["19:42:31", "admin", "force re-verify: Employee 12"],
  ["19:36:02", "Employee 07", "voice check: cloned voice blocked, device locked"],
  ["19:21:47", "Employee 03", "level normal → watch"],
] as const;

function LevelChip({ level }: { level: Level }) {
  const c = levelColor(level);
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium" style={{ color: c, background: `color-mix(in oklch, ${c} 14%, transparent)` }}>
      <span className="size-1 rounded-full" style={{ background: c }} />
      {levelLabel(level)}
    </span>
  );
}

function OrgConsoleMock() {
  const alerts = ROSTER.filter((r) => r.locked || r.pct < 80).length;
  return (
    <div className="overflow-hidden rounded-lg border bg-background/60 shadow-lg shadow-black/20">
      <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium">
          <LogoMark className="size-4" /> Org console
        </span>
        <span className="rounded-full border border-trust-watch/40 px-1.5 font-mono text-[9px] tracking-wider text-trust-watch uppercase">synthetic</span>
      </div>
      <div className="grid grid-cols-3 divide-x border-b text-center">
        {[
          ["20", "employees"],
          [String(alerts), "need attention"],
          ["1", "locked"],
        ].map(([v, k]) => (
          <div key={k} className="py-2">
            <div className="tnum text-base font-semibold">{v}</div>
            <div className="text-[10px] text-muted-foreground">{k}</div>
          </div>
        ))}
      </div>
      <table className="w-full text-left text-[11px]">
        <tbody>
          {ROSTER.map((r) => {
            const level: Level = r.locked ? "locked" : levelFromConfidence(r.pct / 100);
            const c = levelColor(level);
            return (
              <tr key={r.who} className="border-b last:border-b-0">
                <td className="py-1.5 pr-2 pl-3">
                  <div className="font-medium">{r.who}</div>
                  <div className="text-[10px] text-muted-foreground">{r.team}</div>
                </td>
                <td className="w-24 py-1.5 pr-2">
                  <div className="flex items-center gap-1.5">
                    <div className="h-1.5 flex-1 rounded-full bg-muted">
                      <div className="h-full rounded-full" style={{ width: `${Math.max(r.pct, 2)}%`, background: c }} />
                    </div>
                    <span className="tnum w-7 text-right font-mono text-[10px]">{r.locked ? "—" : `${r.pct}%`}</span>
                  </div>
                </td>
                <td className="py-1.5 pr-2">
                  <LevelChip level={level} />
                </td>
                <td className="hidden py-1.5 pr-3 text-[10px] text-muted-foreground sm:table-cell">{r.alert}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="border-t bg-muted/20 px-3 py-2">
        <div className="eyebrow mb-1.5 text-[9px]">Audit trail</div>
        <ul className="space-y-1">
          {AUDIT.map(([t, who, what]) => (
            <li key={t + what} className="flex gap-2 text-[10px]">
              <span className="tnum shrink-0 font-mono text-muted-foreground">{t}</span>
              <span className={cn("shrink-0 font-medium", who === "admin" && "text-brand")}>{who}</span>
              <span className="truncate text-muted-foreground">{what}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** newGoal's two UIs: the overlay for the individual, the .tech org console for a security team. */
export function ProductSurfaces() {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div className="panel flex flex-col p-6">
        <div className="flex items-center gap-2">
          <Laptop className="size-5 text-brand" />
          <span className="eyebrow">For individuals</span>
        </div>
        <h3 className="mt-2 text-xl font-semibold tracking-tight">On your Mac: the overlay</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          A small app that floats above everything you do. It never captures input itself; the agent does, and only timing leaves the Mac.
        </p>
        <ol className="mt-5 flex flex-1 flex-col justify-between gap-5">
          {FRAMES.map((f, i) => (
            <li key={f.key} className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,15rem)_1fr] sm:items-center sm:gap-5">
              {f.screen}
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span className="tnum grid size-5 place-items-center rounded-full bg-muted font-mono text-[10px]">{i + 1}</span>
                  {f.title}
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="panel flex flex-col p-6">
        <div className="flex items-center gap-2">
          <Building2 className="size-5 text-brand-2" />
          <span className="eyebrow">For small companies</span>
        </div>
        <h3 className="mt-2 text-xl font-semibold tracking-tight">For your security team: the org console</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          One screen for every employee session: who is drifting, who is mid-challenge, who got locked, and an audit trail of every trust change, alert,
          challenge and admin action for tracing a breach back.
        </p>
        <div className="mt-5 flex-1">
          <OrgConsoleMock />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">Illustration. The console demo uses synthetic, anonymized employees.</p>
          <Button asChild size="sm" variant="outline">
            <Link href="/admin?mock=1">
              Open the org console demo <ArrowRight />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
