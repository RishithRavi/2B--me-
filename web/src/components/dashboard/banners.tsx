"use client";

import { AudioLines, ChevronDown, Hourglass, Lock, MonitorSmartphone, ShieldAlert, WifiOff } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChallengeLive, LiveDevice } from "@/lib/contracts";
import type { KnownDevice } from "@/lib/live";
import { useNow } from "@/lib/hooks";
import { fmtAgo } from "@/lib/ui";
import { cn } from "@/lib/utils";

const TRIGGER_TEXT: Record<ChallengeLive["trigger"], string> = {
  proactive: "Trust stayed below 40% for 2 ticks. Behavior alone never blocks, so we're asking for a voice check.",
  step_up: "A high-risk action needs a voice check before it can go through.",
  unlock: "Voice unlock in progress.",
  redteam: "Red-team challenge (no trust effect).",
  sandbox: "Sandbox challenge (no trust effect).",
};

const mss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * Proactive/step-up challenge banner → /verify?c=…
 * readOnly: an observer screen (stage view, an admin's drill-in) never answers someone else's voice check; it shows
 * that the person at the laptop is being asked. compact: one row (the stage view).
 */
export function ChallengeBanner({
  challenge,
  large = false,
  compact = false,
  readOnly = false,
}: {
  challenge: ChallengeLive | null;
  large?: boolean;
  compact?: boolean;
  readOnly?: boolean;
}) {
  const now = useNow(1000);
  if (!challenge) return null;
  const expires = challenge.expires_at ? Math.max(0, Math.round((Date.parse(challenge.expires_at) - now) / 1000)) : null;
  const expiring = expires === 0;
  const href = challenge.verify_url && challenge.verify_url.startsWith("/") ? challenge.verify_url : `/verify?c=${encodeURIComponent(challenge.challenge_id)}`;
  const when = expires === null ? null : expiring ? " Expiring…" : ` Expires in ${mss(expires)}.`;
  const action = readOnly ? (
    <span className={cn("inline-flex shrink-0 items-center gap-2 text-muted-foreground", compact ? "text-sm" : large ? "text-base" : "text-xs")}>
      <Hourglass className={cn("size-4 text-trust-watch", !expiring && "animate-pulse")} /> Waiting for the person at the laptop to answer
    </span>
  ) : expiring ? (
    <Button size={large ? "lg" : "sm"} className="shrink-0" disabled>
      <AudioLines /> Open voice check
    </Button>
  ) : (
    <Button asChild size={large ? "lg" : "sm"} className="shrink-0">
      <Link href={href}>
        <AudioLines /> Open voice check
      </Link>
    </Button>
  );
  if (compact) {
    return (
      <div role="status" className="flex items-center gap-3 rounded-xl border border-trust-watch/45 bg-trust-watch/10 px-4 py-2">
        <ShieldAlert className="size-5 shrink-0 text-trust-watch" />
        <div className="min-w-0 flex-1 truncate text-base">
          <span className="font-semibold">Voice check requested</span>
          <span className="text-muted-foreground">
            {" "}
            · {challenge.trigger.replace("_", "-")} · attempt {challenge.attempt} · {challenge.status.replace("_", " ")}
            {when && ` ·${when.replace(/\.$/, "")}`}
          </span>
        </div>
        {action}
      </div>
    );
  }
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-trust-watch/45 bg-trust-watch/10 px-4 py-3 sm:flex-row sm:items-center",
        large && "px-6 py-4",
      )}
    >
      <ShieldAlert className={cn("size-5 shrink-0 text-trust-watch", large && "size-7")} />
      <div className="min-w-0 flex-1">
        <div className={cn("font-semibold", large ? "text-xl" : "text-sm")}>
          Voice check requested{" "}
          <span className="font-normal text-muted-foreground">
            · {challenge.trigger.replace("_", "-")} · attempt {challenge.attempt} · {challenge.status.replace("_", " ")}
          </span>
        </div>
        <div className={cn("text-muted-foreground", large ? "text-base" : "text-xs")}>
          {TRIGGER_TEXT[challenge.trigger]}
          {when}
        </div>
      </div>
      {action}
    </div>
  );
}

/** The device's agent stopped reporting: what's on screen is its last known state, not a live reading. */
export function OfflineBanner({ lastSeen }: { lastSeen: string | null | undefined }) {
  useNow(5000);
  return (
    <div role="status" className="flex items-center gap-3 rounded-xl border border-trust-watch/45 bg-trust-watch/10 px-4 py-3">
      <WifiOff className="size-5 shrink-0 text-trust-watch" />
      <div className="min-w-0 flex-1 text-sm">
        <span className="font-semibold">Agent offline</span>
        <span className="text-muted-foreground">
          {lastSeen ? ` — last seen ${fmtAgo(lastSeen)}` : ""}; trust shown is the last known value.
        </span>
      </div>
    </div>
  );
}

/** readOnly: someone else's device (an admin's drill-in): no voice unlock from this screen. */
export function LockedBanner({
  device,
  onUnlock,
  busy,
  readOnly = false,
}: {
  device: LiveDevice | null;
  onUnlock: () => void;
  busy: boolean;
  readOnly?: boolean;
}) {
  if (!device?.locked) return null;
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-xl border border-trust-locked/50 bg-trust-locked/12 px-4 py-3 sm:flex-row sm:items-center">
      <Lock className="size-5 shrink-0 text-trust-locked" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">Device locked{device.lock_reason ? ` — ${device.lock_reason.replaceAll("_", " ")}` : ""}</div>
        <div className="text-xs text-muted-foreground">
          Every high-risk action is declined until the owner passes a fresh voice check (or TOTP).
        </div>
      </div>
      {!readOnly && (
        <Button size="sm" onClick={onUnlock} disabled={busy} className="shrink-0">
          <AudioLines /> Unlock with voice
        </Button>
      )}
    </div>
  );
}

/** Admin sees every device; pick one to focus the stream (?device_id=). */
export function DevicePicker({
  devices,
  current,
  onPick,
}: {
  devices: Record<string, KnownDevice>;
  current: string | null;
  onPick: (id: string) => void;
}) {
  const list = Object.values(devices);
  if (list.length < 2) return null;
  const cur = current ? devices[current] : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <MonitorSmartphone /> {cur?.label ?? "Device"} <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Devices ({list.length})</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {list.map((d) => (
          <DropdownMenuItem key={d.id} onSelect={() => onPick(d.id)} className={cn(d.id === current && "font-medium")}>
            {d.label}
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">{d.id.slice(0, 8)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
