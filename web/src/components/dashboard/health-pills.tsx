"use client";

import { AudioLines, Gauge, HeartPulse, KeyboardOff, Link2, Radio, Zap } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { HealthLive, PresenceLive } from "@/lib/contracts";
import { useNow } from "@/lib/hooks";
import { MODALITIES, modalityColor, modalityIcon, modalityLabel } from "@/lib/ui";
import { cn } from "@/lib/utils";

type Tone = "ok" | "warn" | "bad" | "off";

const TONE: Record<Tone, string> = {
  ok: "var(--trust-normal)",
  warn: "var(--trust-watch)",
  bad: "var(--trust-suspicious)",
  off: "var(--muted-foreground)",
};

function Pill({ tone, icon, children, hint }: { tone: Tone; icon: ReactNode; children: ReactNode; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex h-7 cursor-default items-center gap-1.5 rounded-full border bg-card px-2.5 text-xs whitespace-nowrap">
          <span className="size-1.5 rounded-full" style={{ background: TONE[tone] }} />
          <span className="text-muted-foreground [&_svg]:size-3.5">{icon}</span>
          <span className="tnum font-mono">{children}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

const age = (s: number | null | undefined, extra: number) => (s === null || s === undefined ? null : s + extra);
const fmtS = (s: number | null) => (s === null ? "—" : s < 10 ? `${s.toFixed(1)}s` : s < 120 ? `${Math.round(s)}s` : `${Math.round(s / 60)}m`);

/** Full-width red banner while macOS Secure Event Input is on (password field): the keyboard is missing, not anomalous. */
export function SecureInputBanner({ health }: { health: HealthLive | null }) {
  if (!health?.secure_input) return null;
  return (
    <div role="alert" className="flex items-center gap-3 rounded-xl border border-trust-suspicious/50 bg-trust-suspicious/15 px-4 py-2.5 text-sm">
      <KeyboardOff className="size-5 text-trust-suspicious" />
      <span className="font-semibold tracking-wide text-trust-suspicious">SECURE INPUT — keyboard blind</span>
      <span className="text-muted-foreground">
        A password field has Secure Event Input on. Keyboard evidence is treated as missing, not anomalous.
      </span>
    </div>
  );
}

export function HealthPills({ health, healthAt, presence }: { health: HealthLive | null; healthAt: number | null; presence: PresenceLive | null }) {
  const now = useNow(1000);
  if (!health) {
    return (
      <div className="flex flex-wrap gap-2">
        <Pill tone="off" icon={<HeartPulse />} hint="No agent health report yet">
          agent —
        </Pill>
      </div>
    );
  }
  const extra = healthAt ? Math.max(0, (now - healthAt) / 1000) : 0;
  const hb = age(health.heartbeat_age_s, extra);
  const hbTone: Tone = hb === null ? "off" : hb < 10 ? "ok" : hb < 30 ? "warn" : "bad";
  const quota = health.elevenlabs_quota;
  const rtt = health.rtt_ms;

  return (
    <div className="flex flex-wrap gap-2">
      <Pill tone={hbTone} icon={<HeartPulse />} hint="Time since the agent's last heartbeat (binding needs < 30 s)">
        agent {fmtS(hb)}
      </Pill>
      <Pill
        tone={health.tap_events_per_s === null ? "off" : health.tap_events_per_s > 0 ? "ok" : "warn"}
        icon={<Zap />}
        hint="Input events per second seen by the event tap"
      >
        {health.tap_events_per_s === null ? "—" : health.tap_events_per_s.toFixed(1)} ev/s
      </Pill>
      {MODALITIES.map((m) => {
        const a = age(health.last_block_age_s[m] ?? null, extra);
        const Icon = modalityIcon(m);
        const tone: Tone = a === null ? "off" : a < 30 ? "ok" : a < 120 ? "warn" : "off";
        return (
          <Pill key={m} tone={tone} icon={<Icon style={{ color: modalityColor(m) }} />} hint={`Last ${modalityLabel(m).toLowerCase()} block`}>
            {fmtS(a)}
          </Pill>
        );
      })}
      <Pill tone={rtt === null ? "off" : rtt < 150 ? "ok" : rtt < 400 ? "warn" : "bad"} icon={<Radio />} hint="Agent ↔ server round-trip time">
        {rtt === null ? "—" : `${Math.round(rtt)} ms`}
      </Pill>
      <Pill tone={health.voice_warm ? "ok" : "warn"} icon={<AudioLines />} hint="Voice step-up models loaded and warm">
        voice {health.voice_warm ? "warm" : "cold"}
      </Pill>
      <Pill
        tone={quota === null ? "off" : quota >= 0.8 ? "warn" : "ok"}
        icon={<Gauge />}
        hint="ElevenLabs character quota used this period (amber at 80%)"
      >
        11L {quota === null ? "—" : `${Math.round(quota * 100)}%`}
      </Pill>
      {presence && (
        <Pill
          tone={presence.binding === "co-present" ? "ok" : "warn"}
          icon={<Link2 />}
          hint="Browser ↔ agent co-presence (activity correlation). Remote sessions fall back to 30%."
        >
          <span className={cn(presence.binding === "remote" && "text-trust-watch")}>
            {presence.binding}
            {presence.score !== null ? ` ${presence.score.toFixed(2)}` : ""}
          </span>
        </Pill>
      )}
    </div>
  );
}
