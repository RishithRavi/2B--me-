"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ORG_SIZE } from "@/lib/admin-mock";
import { api } from "@/lib/api";
import { useMounted } from "@/lib/hooks";
import type { StatusOut } from "@/lib/contracts";
import { useMockMode } from "@/lib/mode";
import { fmtAgo, fmtDuration } from "@/lib/ui";
import { cn } from "@/lib/utils";

const POLL_MS = 15_000;

type Tone = "ok" | "bad" | "warn" | "neutral";

/** Hidden below `sm`, so the phone strip shows whole items only instead of one cut mid-word at the edge. */
const WIDE_ONLY = "hidden sm:inline-flex";

function Item({
  ok,
  tone,
  label,
  short,
  hint,
  className,
}: {
  ok?: boolean | null;
  tone?: Tone;
  label: string;
  /** shorter label shown below `sm` */
  short?: string;
  hint?: string;
  className?: string;
}) {
  const t: Tone = tone ?? (ok === null || ok === undefined ? "neutral" : ok ? "ok" : "bad");
  const color = { ok: "var(--trust-normal)", bad: "var(--trust-suspicious)", warn: "var(--trust-watch)", neutral: "var(--muted-foreground)" }[t];
  const body = (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap", className)}>
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {short ? (
        <>
          <span className="sm:hidden">{short}</span>
          <span className="hidden sm:inline">{label}</span>
        </>
      ) : (
        label
      )}
    </span>
  );
  if (!hint) return body;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent side="top">{hint}</TooltipContent>
    </Tooltip>
  );
}

/** What is actually running, from /status (StatusOut.model_backend, else the older inference.model_backend). */
export function modelBackend(s: StatusOut): string | null {
  if (s.model_backend) return s.model_backend;
  const v = s.inference?.["model_backend"];
  return typeof v === "string" ? v : null;
}

function explanations(s: StatusOut): string | null {
  const v = s.inference?.["explanations"];
  return typeof v === "string" ? v : null;
}

/** Stub voice is badged loudly: its results are canned, never live analysis (§8 C2 "Stub honesty"). */
function StubVoice({ hint = "VOICE_MODE=stub: voice results on this server are canned demo outcomes, not a live analysis of the audio." }: { hint?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-trust-watch/50 bg-trust-watch/15 px-2 py-px font-sans text-[11px] font-semibold whitespace-nowrap text-trust-watch">
          <span className="size-1.5 animate-pulse-dot rounded-full bg-trust-watch" />
          Voice: simulated (stub)
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Mock mode describes no server: no Tiger, model, writer or devices-online claims, only what the browser simulates
 * (a 20-device org on /admin, canned voice results, template explanations).
 */
function MockStrip({ pathname }: { pathname: string }) {
  return (
    <>
      <StubVoice hint="Demo mode: voice results are simulated in this browser, never a live analysis of the audio." />
      <Item
        tone="warn"
        label="demo · simulated in this browser"
        short="demo · simulated"
        hint="Mock mode: the data on this page is simulated in your browser, not read from a live device, Tiger or the model"
      />
      {pathname.startsWith("/admin") && (
        <Item tone="neutral" label={`simulated org · ${ORG_SIZE} devices`} className={WIDE_ONLY} hint="The org console demo simulates this many employee devices in the browser" />
      )}
      <Item tone="neutral" label="explanations template" className={WIDE_ONLY} hint="Anomaly explanations in the demo come from a local template" />
    </>
  );
}

/**
 * Thin P0 status strip: stub-voice warning, Tiger, model backend, voice, writer queue/drops, devices online, retrain
 * mode and explanation source. Tolerates API down. Below `sm` only the voice, Tiger and device items show.
 */
export function StatusFooter() {
  const pathname = usePathname();
  const mock = useMockMode();
  const mounted = useMounted();
  const [status, setStatus] = useState<StatusOut | null>(null);
  const [offline, setOffline] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  useEffect(() => {
    if (!mounted) return; // wait for the client-side mock flag (hydration renders with the server value)
    if (mock) return; // the mock strip describes the browser simulation, not a server
    let alive = true;
    const ctl = new AbortController();
    const poll = async () => {
      try {
        const s = await api.status(ctl.signal);
        if (!alive) return;
        setStatus(s);
        setOffline(false);
      } catch {
        if (!alive) return;
        setOffline(true);
      } finally {
        if (alive) setCheckedAt(new Date().toISOString());
      }
    };
    void poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      ctl.abort();
      clearInterval(id);
    };
  }, [mock, mounted]);

  if (pathname === "/overlay") return null; // the Electron overlay has no site chrome
  const backend = status ? modelBackend(status) : null;
  const explain = status ? explanations(status) : null;

  return (
    <footer className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/85 backdrop-blur-md">
      <div className="scrollbar-thin mx-auto flex h-7 max-w-[1440px] items-center gap-4 overflow-x-auto px-4 font-mono text-[11px] text-muted-foreground sm:px-6">
        {mock && mounted ? (
          <MockStrip pathname={pathname} />
        ) : offline || !status ? (
          <Item ok={offline ? false : null} label={offline ? "API offline" : "checking API…"} hint={checkedAt ? `last check ${fmtAgo(checkedAt)}` : undefined} />
        ) : (
          <>
            {status.voice_mode === "stub" && <StubVoice />}
            <Item
              ok={status.ok}
              label={`API ${status.version}`}
              hint={`uptime ${fmtDuration(status.uptime_s)}${status.demo_mode ? " · demo mode" : ""}`}
              className={WIDE_ONLY}
            />
            <Item ok={status.tiger === "up"} label={`Tiger ${status.tiger}`} hint="Tiger Cloud (TimescaleDB): history, baselines, anomalies" />
            {backend && (
              <Item
                tone={backend === "twobme_ml" ? "ok" : "warn"}
                label={`model ${backend}`}
                className={WIDE_ONLY}
                hint={
                  backend === "twobme_ml"
                    ? "twobme_ml: per-user one-class detector, trained only on the enrolled person's blocks"
                    : "fallback: median/MAD distance to the enrolled baseline (twobme_ml not installed on this server)"
                }
              />
            )}
            {status.voice_mode === "real" ? (
              <Item ok={status.voice_warm} label={status.voice_warm ? "voice real · warm" : "voice real · cold"} hint="Real voice pipeline: VAD, speech-to-text, speaker match, anti-spoof, DSP/FFT" />
            ) : (
              status.voice_mode !== "stub" && (
                <Item ok={status.voice_warm} label={status.voice_warm ? "voice warm" : "voice cold"} hint="Voice step-up ready (models loaded and warmed up)" />
              )
            )}
            <Item
              ok={status.writer.dropped === 0 && status.writer.failed_batches === 0}
              label={`writer q ${status.writer.queued} · drop ${status.writer.dropped}`}
              className={WIDE_ONLY}
              hint={`flushed ${status.writer.flushed.toLocaleString()} rows · failed batches ${status.writer.failed_batches}${status.writer.last_flush_at ? ` · last flush ${fmtAgo(status.writer.last_flush_at)}` : ""}`}
            />
            <Item
              ok={status.devices_online > 0}
              label={`${status.devices_online} device${status.devices_online === 1 ? "" : "s"} online`}
              short={`${status.devices_online} online`}
            />
            <Item
              tone="neutral"
              label={status.continuous_update ? "manual retrain" : "model frozen"}
              className={WIDE_ONLY}
              hint={
                status.continuous_update
                  ? "Only high-confidence genuine blocks become update candidates; retraining is operator-triggered (Retrain now)"
                  : "Demo freeze: no retraining"
              }
            />
            {explain && (
              <Item
                tone="neutral"
                label={`explanations ${explain}`}
                className={WIDE_ONLY}
                hint={explain === "vultr" ? "Anomaly explanations from Vultr Serverless Inference (feature z-scores only)" : "Anomaly explanations use a local template (no inference key set)"}
              />
            )}
          </>
        )}
        <span className="ml-auto hidden whitespace-nowrap sm:inline">
          {mock ? "simulated stream · no data leaves this browser" : "2bme.tech · only timing aggregates leave the laptop"}
        </span>
      </div>
    </footer>
  );
}
