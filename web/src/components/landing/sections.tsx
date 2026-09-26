import {
  AudioLines,
  Check,
  EyeOff,
  Fingerprint,
  Lock,
  MousePointer2,
  ScanFace,
  ShieldCheck,
  ShieldQuestion,
  TrendingDown,
  Upload,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

import { TRUST_CONFIG } from "@/lib/contracts";
import { levelColor } from "@/lib/ui";

// ---------------------------------------------------------------------------
// How it works
// ---------------------------------------------------------------------------

const STEPS = [
  {
    icon: Fingerprint,
    title: "Enroll one person",
    body: "Work normally for a few minutes. The agent on your Mac turns keyboard, pointer, scroll and app-switch timing into privacy-safe evidence blocks, and 2bME learns a baseline that is yours alone.",
  },
  {
    icon: TrendingDown,
    title: "Score every 5 seconds",
    body: "Fresh blocks are compared with your baseline and fused into one continuous trust score. A password never raises it; only your behavior or a fresh strong check does.",
  },
  {
    icon: ScanFace,
    title: "Ask “still you?”, not “who?”",
    body: "It's a one-class question: new behavior is compared only with your own baseline, so anyone who isn't you stands out without a database of other people's behavior.",
  },
  {
    icon: AudioLines,
    title: "Step up, never block on behavior",
    body: "When trust falls below 40% or a risky action needs more, 2bME asks for an independent factor: a spoken random phrase checked for your voice and for cloning, or a one-time code. Only that check can block.",
  },
];

export function HowItWorks() {
  return (
    <div className="space-y-5">
      <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <li key={s.title} className="panel relative flex flex-col p-5">
            <div className="flex items-center justify-between">
              <span className="grid size-10 place-items-center rounded-xl bg-muted ring-1 ring-foreground/10">
                <s.icon className="size-5 text-brand" />
              </span>
              <span className="font-mono text-xs text-muted-foreground">0{i + 1}</span>
            </div>
            <h3 className="mt-5 font-semibold">{s.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
          </li>
        ))}
      </ol>
      <OneClass />
    </div>
  );
}

/** §1.9: the 1:1 verification chain, next to the 1:N identification it replaces. */
function OneClass() {
  const chain = [
    ["Typicality", "How usual is this block for your own baseline?"],
    ["Evidence", "Each block nudges the odds that it's still you, up or down."],
    ["Trust", "The nudges add up to P(still you): a calibrated probability, not a feeling."],
  ] as const;
  return (
    <div className="panel grid grid-cols-1 gap-6 overflow-hidden p-6 lg:grid-cols-[1fr_1.4fr]">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-dashed p-4">
          <ShieldQuestion className="size-5 text-muted-foreground" />
          <div className="mt-3 text-sm font-semibold text-muted-foreground line-through decoration-trust-suspicious/70">Who is this?</div>
          <p className="mt-1.5 text-xs leading-snug text-muted-foreground">Identification: pick one of N people. Needs everyone&apos;s data.</p>
        </div>
        <div className="rounded-xl border border-brand/50 bg-brand/8 p-4">
          <ScanFace className="size-5 text-brand" />
          <div className="mt-3 text-sm font-semibold">Is this still you?</div>
          <p className="mt-1.5 text-xs leading-snug text-muted-foreground">Verification: one person, one baseline. Anyone else simply doesn&apos;t fit.</p>
        </div>
      </div>
      <div>
        <p className="eyebrow">How &ldquo;truly you&rdquo; is decided</p>
        <ol className="mt-3 grid gap-3 sm:grid-cols-3">
          {chain.map(([k, v], i) => (
            <li key={k} className="relative">
              <div className="flex items-center gap-2">
                <span className="tnum grid size-6 place-items-center rounded-full bg-muted font-mono text-[11px]">{i + 1}</span>
                <span className="text-sm font-semibold">{k}</span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{v}</p>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Every threshold trades false accepts against false rejects, so behavior raises the alarm and an independent factor makes the call. The
          measured trade-off, weak numbers included, is on the{" "}
          <a href="/lab" className="text-foreground underline underline-offset-4">
            verification evidence page
          </a>
          .
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Risk-based step-up
// ---------------------------------------------------------------------------

function Flow({ title, conf, steps, result, tone }: { title: string; conf: number; steps: ReactNode[]; result: ReactNode; tone: "ok" | "bad" }) {
  const color = tone === "ok" ? "var(--trust-normal)" : "var(--trust-suspicious)";
  const level = tone === "ok" ? "normal" : "suspicious";
  return (
    <div className="panel flex flex-col p-6">
      <div className="eyebrow">{title}</div>
      <div className="mt-4 flex items-end gap-3">
        <span className="tnum text-5xl font-semibold tracking-tight" style={{ color: levelColor(level) }}>
          {Math.round(conf * 100)}%
        </span>
        <span className="pb-1.5 text-sm text-muted-foreground">behavioral confidence</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${conf * 100}%`, background: color }} />
      </div>
      <ol className="mt-5 flex-1 space-y-2.5">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2.5 text-sm">
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground" />
            <span>{s}</span>
          </li>
        ))}
      </ol>
      <div className="mt-5 rounded-lg border px-3 py-2.5 text-sm" style={{ borderColor: `color-mix(in oklch, ${color} 40%, transparent)`, background: `color-mix(in oklch, ${color} 8%, transparent)` }}>
        {result}
      </div>
    </div>
  );
}

const TIERS = [
  { tier: "R0", what: "view", min: TRUST_CONFIG.policy.tiers.R0.min_conf },
  { tier: "R1", what: "purchase under $100", min: TRUST_CONFIG.policy.tiers.R1.min_conf },
  { tier: "R2", what: "$100–499, export", min: TRUST_CONFIG.policy.tiers.R2.min_conf },
  { tier: "R3", what: "$500+, add payee, password change", min: TRUST_CONFIG.policy.tiers.R3.min_conf },
];

export function RiskExamples() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1fr_0.9fr]">
      <Flow
        title="Known user · $2,000 purchase"
        conf={0.97}
        tone="ok"
        steps={["The owner is at the keyboard, and the browser is co-present with the Mac's live input", "97% clears the R3 bar of 90%"]}
        result={
          <span>
            <b className="font-mono text-trust-normal">Y</b> · approved, frictionless checkout
          </span>
        }
      />
      <Flow
        title="Stolen authenticated session · $2,000 purchase"
        conf={0.31}
        tone="bad"
        steps={[
          "Someone else is typing, or the cookie is used from another machine (a remote session starts at 30%)",
          <span key="c">
            <b className="font-mono text-trust-watch">C</b> · step-up: voice or one-time-code challenge
          </span>,
        ]}
        result={
          <span>
            Owner verifies → <b className="font-mono text-trust-normal">Y</b>. Wrong or cloned voice → <b className="font-mono text-trust-suspicious">N</b>, device
            locked.
          </span>
        }
      />
      <div className="panel p-6">
        <div className="eyebrow">Friction scales with risk</div>
        <table className="mt-4 w-full text-sm">
          <tbody>
            {TIERS.map((t) => (
              <tr key={t.tier} className="border-b last:border-b-0">
                <td className="py-2 pr-2 font-mono text-xs text-muted-foreground">{t.tier}</td>
                <td className="py-2 pr-2">{t.what}</td>
                <td className="tnum py-2 text-right font-mono text-xs whitespace-nowrap">≥ {Math.round(t.min * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Below the bar the action steps up (C); it is declined (N) only when a failed check locked the device. Results use 3DS-style Y/C/N codes in a
          checkout demo scenario, not affiliated with Visa.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

const NEVER = ["typed content", "passwords", "clipboard", "document text", "window titles", "URLs", "which key you pressed", "app names", "screen coordinates"];

const SAMPLE_BLOCK = `{
  "modality": "keyboard",
  "n": 20,
  "features": {
    "kb.hold_p50": 96.0,
    "kb.dd_p50": 148.0,
    "kb.tri_p50": 301.0,
    "kb.speed_kps": 6.4,
    "kb.bksp_rate": 0.05,
    …
  }
}`;

export function PrivacyPromise() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="panel p-6">
        <div className="flex items-center gap-2">
          <EyeOff className="size-5 text-brand" />
          <h3 className="text-lg font-semibold">Never leaves your Mac</h3>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {NEVER.map((n) => (
            <span key={n} className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">
              <X className="size-3 text-trust-suspicious" /> {n}
            </span>
          ))}
        </div>
        <ul className="mt-5 space-y-3 text-sm text-muted-foreground">
          <li className="flex gap-2.5">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-trust-normal" />
            <span>
              <b className="text-foreground">Keycodes stay on the capture thread.</b> Each key becomes a hand-level class (left letter, right letter,
              space…) the moment it&apos;s captured, and the keycode is dropped. All digits collapse into one class, so PINs and card numbers can&apos;t be
              recovered.
            </span>
          </li>
          <li className="flex gap-2.5">
            <MousePointer2 className="mt-0.5 size-4 shrink-0 text-trust-normal" />
            <span>
              <b className="text-foreground">Pointer and apps are abstracted on device.</b> Mouse paths become statistics normalized by the screen
              size; apps become a category such as browser or IDE.
            </span>
          </li>
          <li className="flex gap-2.5">
            <Lock className="mt-0.5 size-4 shrink-0 text-trust-normal" />
            <span>
              <b className="text-foreground">Password fields blind the keyboard.</b> While macOS Secure Event Input is on, keyboard evidence is treated as
              missing, not anomalous.
            </span>
          </li>
        </ul>
      </div>

      <div className="panel flex flex-col p-6">
        <div className="flex items-center gap-2">
          <Upload className="size-5 text-brand" />
          <h3 className="text-lg font-semibold">What does leave: aggregates</h3>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          Percentiles, rates and counts per evidence block. Never a per-key sequence, hashed or not. The block format, trimmed:
        </p>
        <pre className="scrollbar-thin mt-4 flex-1 overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">{SAMPLE_BLOCK}</pre>
        <ul className="mt-4 space-y-1.5 text-xs text-muted-foreground">
          <li className="flex gap-2">
            <Check className="mt-0.5 size-3.5 shrink-0 text-trust-normal" />
            Every dashboard has a &ldquo;What left this laptop&rdquo; drawer with the literal last payload.
          </li>
          <li className="flex gap-2">
            <Check className="mt-0.5 size-3.5 shrink-0 text-trust-normal" />
            Our merge gate fails if a window title, key value, clipboard or bundle ID can reach a logger or the network.
          </li>
          <li className="flex gap-2">
            <Check className="mt-0.5 size-3.5 shrink-0 text-trust-normal" />
            We send block aggregates, not only risk events, because baselines, retraining and the org console need them. Still never content.
          </li>
        </ul>
      </div>

      <div className="panel flex flex-col p-6">
        <div className="flex items-center gap-2">
          <AudioLines className="size-5 text-brand" />
          <h3 className="text-lg font-semibold">Voice, disclosed plainly</h3>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          Challenge audio is scored and then deleted. Only embeddings and scalar scores are stored.
        </p>
        <blockquote className="mt-4 border-l-2 border-brand/60 pl-4 text-[15px] leading-relaxed">
          Our server deletes challenge audio after scoring and stores only embeddings and scores. ElevenLabs processes the prompt and STT audio and, on our
          plan, retains it in account history (Zero Retention is enterprise-only).{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[13px]">STT_BACKEND=local</code> avoids this.
        </blockquote>
        <div className="mt-auto grid grid-cols-2 gap-3 pt-6 text-xs">
          <div className="rounded-lg bg-muted/50 p-3">
            <div className="eyebrow text-[10px]">Kept</div>
            <ul className="mt-2 space-y-1 text-muted-foreground">
              <li>speaker embedding</li>
              <li>spectral summary</li>
              <li>scores and the decision</li>
            </ul>
          </div>
          <div className="rounded-lg bg-muted/50 p-3">
            <div className="eyebrow text-[10px]">Deleted after scoring</div>
            <ul className="mt-2 space-y-1 text-muted-foreground">
              <li>your recorded answer</li>
              <li>the transcript</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sponsors (only what is built)
// ---------------------------------------------------------------------------

const SPONSORS: { name: string; role: string; mono?: boolean; note?: string }[] = [
  { name: "Tiger Data", role: "behavior history, baselines and anomalies: hypertables, compression, continuous aggregates" },
  { name: "Vultr", role: "hosting for the API and the behavioral model", note: "deploying" },
  { name: "ElevenLabs", role: "spoken challenge prompts and synthetic voices for spoof testing" },
  { name: ".tech", role: "2bme.tech: this site and the org console", mono: true },
  { name: "NSA Hearsay", role: "voice anti-spoof: the synthetic-speech check in the step-up" },
  { name: "Visa", role: "3DS-style Y/C/N checkout", note: "demo scenario, not affiliated" },
  { name: "Backboard", role: "long-term contextual behavior history", note: "roadmap" },
];

export function SponsorStrip() {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border ring-1 ring-foreground/10 lg:grid-cols-4">
      {SPONSORS.map((s) => (
        <div key={s.name} className="bg-card p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
            <div className={s.mono ? "font-mono text-lg font-semibold" : "text-lg font-semibold tracking-tight"}>{s.name}</div>
            {s.note && (
              <span className="rounded-full border border-trust-watch/40 px-1.5 py-px text-[10px] font-medium whitespace-nowrap text-trust-watch">{s.note}</span>
            )}
          </div>
          <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{s.role}</div>
        </div>
      ))}
      <div className="bg-card p-5">
        <div className="text-sm font-medium">Claims match what&apos;s built</div>
        <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          Anything not live is labelled. Measured results, weak ones included, are on{" "}
          <a href="/lab" className="text-foreground underline underline-offset-4">
            /lab
          </a>
          .
        </div>
      </div>
    </div>
  );
}
