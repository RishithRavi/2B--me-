"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useMounted } from "@/lib/hooks";
import type { StatusOut } from "@/lib/contracts";
import { useMockMode } from "@/lib/mode";
import { fmtAgo, fmtDuration } from "@/lib/ui";
import { cn } from "@/lib/utils";

const POLL_MS = 15_000;

const MOCK_STATUS: StatusOut = {
  ok: true,
  version: "mock",
  uptime_s: 3600,
  tiger: "up",
  voice_warm: true,
  demo_mode: true,
  continuous_update: true,
  writer: { queued: 0, dropped: 0, flushed: 18234, failed_batches: 0, last_flush_at: null },
  devices_online: 1,
  elevenlabs: { used_frac: 0.42 },
  inference: null,
  voice_mode: "stub",
  model_backend: "twobme_ml",
};

function Item({ ok, label, hint, className }: { ok: boolean | null; label: string; hint?: string; className?: string }) {
  const color = ok === null ? "var(--muted-foreground)" : ok ? "var(--trust-normal)" : "var(--trust-suspicious)";
  const body = (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", className)}>
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {label}
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

/** Thin P0 status strip: Tiger up/down, voice warm, writer queue/drops, devices online. Tolerates API down. */
export function StatusFooter() {
  const pathname = usePathname();
  const mock = useMockMode();
  const mounted = useMounted();
  const [status, setStatus] = useState<StatusOut | null>(null);
  const [offline, setOffline] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  useEffect(() => {
    if (!mounted) return; // wait for the client-side mock flag (hydration renders with the server value)
    if (mock) {
      setStatus(MOCK_STATUS);
      setOffline(false);
      return;
    }
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

  return (
    <footer className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/85 backdrop-blur-md">
      <div className="scrollbar-thin mx-auto flex h-7 max-w-[1440px] items-center gap-4 overflow-x-auto px-4 font-mono text-[11px] text-muted-foreground sm:px-6">
        {offline || !status ? (
          <Item ok={offline ? false : null} label={offline ? "API offline" : "checking API…"} hint={checkedAt ? `last check ${fmtAgo(checkedAt)}` : undefined} />
        ) : (
          <>
            <Item ok={status.ok} label={`API ${status.version}`} hint={`uptime ${fmtDuration(status.uptime_s)}${status.demo_mode ? " · demo mode" : ""}`} />
            <Item ok={status.tiger === "up"} label={`Tiger ${status.tiger}`} hint="Tiger Cloud (TimescaleDB): history, baselines, anomalies" />
            <Item ok={status.voice_warm} label={status.voice_warm ? "voice warm" : "voice cold"} hint="Voice models loaded (VAD, ECAPA, anti-spoof)" />
            <Item
              ok={status.writer.dropped === 0 && status.writer.failed_batches === 0}
              label={`writer q ${status.writer.queued} · drop ${status.writer.dropped}`}
              hint={`flushed ${status.writer.flushed.toLocaleString()} rows · failed batches ${status.writer.failed_batches}${status.writer.last_flush_at ? ` · last flush ${fmtAgo(status.writer.last_flush_at)}` : ""}`}
            />
            <Item ok={status.devices_online > 0} label={`${status.devices_online} device${status.devices_online === 1 ? "" : "s"} online`} />
            {status.continuous_update && <Item ok={null} label="continuous update on" />}
          </>
        )}
        <span className="ml-auto hidden whitespace-nowrap sm:inline">
          {mock ? "simulated stream · no data leaves this browser" : "2bme.tech · only timing aggregates leave the laptop"}
        </span>
      </div>
    </footer>
  );
}
