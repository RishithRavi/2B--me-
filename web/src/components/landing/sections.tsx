import { ArrowRight, AudioLines, EyeOff, Fingerprint, Lock, ShieldCheck, TrendingDown } from "lucide-react";
import type { ReactNode } from "react";

const STEPS = [
  {
    icon: Fingerprint,
    n: "01",
    title: "Enroll",
    body: "Work normally for a while. The on-device agent turns keyboard, pointer, scroll and app-switch timing into privacy-safe evidence blocks, and 2bME trains an identity model that is yours alone.",
  },
  {
    icon: TrendingDown,
    n: "02",
    title: "Continuous trust",
    body: "Every 5 seconds, fresh blocks are scored against your profile and fused into one trust score. Credentials never buy high trust. Only behavior does. A different person at the keyboard drags it down.",
  },
  {
    icon: AudioLines,
    n: "03",
    title: "Voice step-up",
    body: "When trust stays below 40% or a risky action needs more, ElevenLabs speaks a random phrase. We check the words, the speaker and the spectrum, and an anti-spoof model catches cloned voices.",
  },
];

export function HowItWorks() {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {STEPS.map((s, i) => (
        <div key={s.n} className="panel relative p-6">
          <div className="flex items-center justify-between">
            <span className="grid size-10 place-items-center rounded-xl bg-muted ring-1 ring-foreground/10">
              <s.icon className="size-5 text-brand" />
            </span>
            <span className="font-mono text-xs text-muted-foreground">{s.n}</span>
          </div>
          <h3 className="mt-5 text-lg font-semibold">{s.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
          {i < STEPS.length - 1 && <ArrowRight className="absolute top-1/2 -right-3.5 z-10 hidden size-5 -translate-y-1/2 text-muted-foreground md:block" />}
        </div>
      ))}
    </div>
  );
}

function Flow({ title, steps, tone }: { title: string; steps: ReactNode[]; tone: "ok" | "bad" }) {
  const color = tone === "ok" ? "var(--trust-normal)" : "var(--trust-suspicious)";
  return (
    <div className="panel p-5">
      <div className="eyebrow">{title}</div>
      <ol className="mt-3 space-y-2">
        {steps.map((s, i) => (
          <li key={i} className="flex items-center gap-2.5 text-sm">
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: i === steps.length - 1 ? color : "var(--muted-foreground)" }} />
            {s}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function RiskExamples() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Flow
        title="Known user · $2,000 purchase"
        tone="ok"
        steps={[
          "Behavioral confidence ≈ 97%",
          "Known user, co-present with the laptop",
          <span key="y">
            <b className="text-trust-normal">Y</b> frictionless checkout
          </span>,
        ]}
      />
      <Flow
        title="Stolen authenticated session · $2,000 purchase"
        tone="bad"
        steps={[
          "Behavioral confidence ≈ 31%",
          <span key="c">
            <b className="text-trust-watch">C</b> step-up authentication
          </span>,
          "Voice (or TOTP) challenge",
          <span key="v">
            Verify <b className="text-trust-normal">Y</b> or block <b className="text-trust-suspicious">N</b>
          </span>,
        ]}
      />
    </div>
  );
}

const NEVER = ["typed content", "passwords", "clipboard", "document text", "window titles", "URLs", "key identities"];

export function PrivacyPromise() {
  return (
    <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
      <div className="panel p-6">
        <div className="flex items-center gap-2">
          <EyeOff className="size-5 text-brand" />
          <h3 className="text-lg font-semibold">We never record</h3>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {NEVER.map((n) => (
            <span key={n} className="rounded-full border px-3 py-1 text-sm text-muted-foreground line-through decoration-trust-suspicious/60">
              {n}
            </span>
          ))}
        </div>
        <ul className="mt-6 space-y-3 text-sm text-muted-foreground">
          <li className="flex gap-2.5">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-trust-normal" />
            <span>
              <b className="text-foreground">Anonymized on the device.</b> Which key you pressed is reduced to a hand-level class (left letter, right letter,
              space…) the moment it&apos;s captured, and the original is discarded. All digits collapse into one class, so PINs and card numbers can&apos;t be recovered.
            </span>
          </li>
          <li className="flex gap-2.5">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-trust-normal" />
            <span>
              <b className="text-foreground">Only aggregates leave.</b> The agent sends percentiles, rates and counts per evidence block. It never
              sends a per-key sequence, absolute screen coordinates, app names or window titles. Apps become a category such as browser or IDE.
            </span>
          </li>
          <li className="flex gap-2.5">
            <Lock className="mt-0.5 size-4 shrink-0 text-trust-normal" />
            <span>
              <b className="text-foreground">Password fields make the keyboard blind.</b> While macOS Secure Event Input is on, keyboard evidence is
              treated as missing, not anomalous.
            </span>
          </li>
        </ul>
      </div>
      <div className="panel flex flex-col p-6">
        <div className="flex items-center gap-2">
          <AudioLines className="size-5 text-brand" />
          <h3 className="text-lg font-semibold">Voice, disclosed plainly</h3>
        </div>
        <blockquote className="mt-4 border-l-2 border-brand/60 pl-4 text-[15px] leading-relaxed">
          Our server deletes challenge audio after scoring and stores only embeddings and scores. ElevenLabs processes the prompt and STT audio
          and, on our plan, retains it in account history (Zero Retention is enterprise-only). <code className="rounded bg-muted px-1 py-0.5 font-mono text-[13px]">STT_BACKEND=local</code> avoids this.
        </blockquote>
        <p className="mt-auto pt-6 text-xs text-muted-foreground">
          Every dashboard has a &ldquo;What left this laptop&rdquo; drawer. It shows the literal last payload the agent sent.
        </p>
      </div>
    </div>
  );
}

const SPONSORS: { name: string; role: string; mono?: boolean; note?: string }[] = [
  { name: "Tiger Data", role: "behavior history, baselines, anomalies, compression" },
  { name: "Vultr", role: "hosting, inference and anomaly explanations" },
  { name: "ElevenLabs", role: "spoken prompts, speech-to-text and the red-team voice corpus" },
  { name: ".tech", role: "this live site: 2bme.tech", mono: true },
  { name: "NSA Hearsay", role: "synthetic-speech detection submission" },
  { name: "Visa", role: "3DS-style checkout", note: "demo scenario, not affiliated" },
];

export function SponsorStrip() {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border ring-1 ring-foreground/10 sm:grid-cols-3 lg:grid-cols-6">
      {SPONSORS.map((s) => (
        <div key={s.name} className="bg-card p-4">
          <div className={s.mono ? "font-mono text-lg font-semibold" : "text-lg font-semibold tracking-tight"}>{s.name}</div>
          <div className="mt-1 text-xs leading-snug text-muted-foreground">{s.role}</div>
          {s.note && <div className="mt-1.5 text-[11px] font-medium text-trust-watch">{s.note}</div>}
        </div>
      ))}
    </div>
  );
}
