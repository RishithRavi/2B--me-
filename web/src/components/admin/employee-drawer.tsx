"use client";

// Per-employee drill-in: trust gauge, 5-min trend, flags, the latest alert with its "why", admin actions, and
// this device's slice of the audit trail. Links out to the live dashboard and to history for trace-back.
import { AudioLines, CheckCheck, ExternalLink, History, Lock, LockOpen, Route, ShieldAlert, StickyNote } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { TrustGauge } from "@/components/dashboard/trust-gauge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { AdminActionIn, AuditRow, RosterRow, TrustLive } from "@/lib/contracts";
import { trustDisplay } from "@/lib/org-live";
import { fmtAgo, fmtClock, fmtPct, fmtZ, levelColor } from "@/lib/ui";
import { cn } from "@/lib/utils";

import { EmployeeAvatar, FlagChips, KindChip, OrgSpark, SyntheticTag, lockReasonText, severityColor } from "./org-bits";

const ANOMALY_LABEL: Record<string, string> = {
  trust_drop: "trust drop",
  takeover_suspected: "takeover suspected",
  voice_spoof: "synthetic voice",
  voice_impostor: "different speaker",
  lock: "device locked",
  redteam_tool: "red-team tool read",
};
const anomalyLabel = (kind: string) => ANOMALY_LABEL[kind] ?? kind.replace(/_/g, " ");

const CHALLENGE_TEXT: Record<string, string> = {
  proactive: "Proactive voice check",
  step_up: "Step-up for a high-risk action",
  unlock: "Owner voice unlock",
  redteam: "Red-team challenge",
  sandbox: "Sandbox challenge",
};

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-2", className)}>
      <h3 className="eyebrow">{title}</h3>
      {children}
    </section>
  );
}

function asTrust(row: RosterRow): TrustLive | null {
  if (row.confidence === null) return null;
  return {
    t: 0,
    logit: 0,
    delta_logit: 0,
    confidence: row.confidence,
    display: row.display ?? trustDisplay(row.confidence),
    level: row.level,
    per_modality: {},
    reasons: [],
    seq: null,
    locked: row.locked,
  };
}

export function EmployeeDrawer({
  row,
  audit,
  acked,
  now,
  mock,
  onClose,
  onAction,
  onTrace,
}: {
  row: RosterRow | null;
  audit: AuditRow[];
  acked: ReadonlyMap<string, AuditRow>;
  now: number;
  mock: boolean;
  onClose: () => void;
  onAction: (input: AdminActionIn, label: string) => Promise<boolean>;
  /** filter the org audit trail to this device (breach trace-back) */
  onTrace: (deviceId: string) => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function run(input: AdminActionIn, label: string) {
    setBusy(input.action);
    try {
      const ok = await onAction(input, label);
      if (ok && input.action === "note") setNote("");
    } finally {
      setBusy(null);
    }
  }

  const open = row !== null;
  const deviceAudit = row ? audit.filter((a) => a.device_id === row.device_id).slice(0, 14) : [];
  const anomaly = row?.last_anomaly ?? null;
  const ack = anomaly ? acked.get(anomaly.id) : undefined;
  const adminLocked = Boolean(row?.locked && row.lock_reason === "admin_lock");
  const voiceLocked = Boolean(row?.locked && !adminLocked);
  const color = row ? levelColor(row.level) : "var(--muted-foreground)";
  const expires = row?.open_challenge?.expires_at ? Math.max(0, Math.round((Date.parse(row.open_challenge.expires_at) - now) / 1000)) : null;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="gap-0 overflow-y-auto p-0 data-[side=right]:w-full sm:max-w-[500px]!"
        // Never land keyboard focus on "Lock device" when the drill-in opens.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {row && (
          <>
            <SheetHeader className="gap-2 border-b px-5 pt-5 pb-4">
              <div className="flex items-center gap-3 pr-8">
                <EmployeeAvatar row={row} size="lg" />
                <div className="min-w-0">
                  <SheetTitle className="flex items-center gap-2 text-lg font-semibold">
                    {row.handle} <SyntheticTag synthetic={row.synthetic} />
                  </SheetTitle>
                  <SheetDescription className="truncate text-[13px]">
                    {row.team ?? (row.synthetic ? "—" : "Enrolled owner")} · <span className="font-mono text-xs">{row.device_label}</span>
                  </SheetDescription>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span className={cn("size-1.5 rounded-full", row.online ? "animate-pulse-dot bg-trust-normal" : "bg-muted-foreground/50")} />
                  {row.online ? "online" : `offline · last seen ${fmtAgo(row.last_seen, now)}`}
                </span>
                <span>mode {row.mode}</span>
                <span>{row.model_version ? `model v${row.model_version}${row.model_backend ? ` · ${row.model_backend}` : ""}` : "no model yet"}</span>
              </div>
            </SheetHeader>

            <div className="space-y-6 px-5 py-5">
              {/* Trust */}
              <div className="grid grid-cols-1 items-center gap-4 sm:grid-cols-[210px_minmax(0,1fr)]">
                <TrustGauge
                  trust={asTrust(row)}
                  locked={row.locked}
                  learning={row.level === "learning"}
                  className="max-w-[210px] [&>p]:hidden"
                />
                <div className="min-w-0 space-y-3">
                  <div>
                    <div className="eyebrow mb-1">Last 5 min</div>
                    <div className="rounded-lg bg-muted/35 px-2 py-1.5">
                      <OrgSpark values={row.sparkline} level={row.level} height={56} dim={!row.online} />
                    </div>
                  </div>
                  <p className="text-[12px] leading-snug text-muted-foreground">
                    {row.locked
                      ? `${lockReasonText(row.lock_reason)}. ${adminLocked ? "Only an admin can clear it." : "Only the owner's fresh voice VERIFY unlocks it."}`
                      : row.level === "learning"
                        ? "Enrolling: collecting this employee's own baseline. No other users' data is used."
                        : "Confidence that the enrolled employee is still the one at the keyboard. Behavior alone never blocks."}
                  </p>
                </div>
              </div>

              {/* Flags + challenge */}
              <Section title="Flags">
                {row.flags.length ? <FlagChips flags={row.flags} /> : <p className="text-[13px] text-muted-foreground">No flags. Nothing unusual on this device.</p>}
                {row.open_challenge && (
                  <div className="flex items-start gap-2.5 rounded-lg bg-trust-watch/10 px-3 py-2.5 ring-1 ring-trust-watch/35">
                    <AudioLines className="mt-0.5 size-4 shrink-0 text-trust-watch" />
                    <div className="text-[13px]">
                      <div className="font-medium">{CHALLENGE_TEXT[row.open_challenge.trigger] ?? row.open_challenge.trigger}</div>
                      <div className="text-muted-foreground">
                        {row.open_challenge.status.replace(/_/g, " ")} · attempt {row.open_challenge.attempt}
                        {expires !== null ? ` · expires in ${expires}s` : ""}
                      </div>
                    </div>
                  </div>
                )}
              </Section>

              {/* Latest alert */}
              {anomaly && (
                <Section title="Latest alert">
                  <div className="space-y-2.5 rounded-lg p-3 ring-1 ring-foreground/10" style={{ background: `color-mix(in oklch, ${severityColor(anomaly.severity)} 6%, transparent)` }}>
                    <div className="flex items-center gap-2 text-[13px]">
                      <ShieldAlert className="size-4" style={{ color: severityColor(anomaly.severity) }} />
                      <span className="font-medium capitalize">{anomalyLabel(anomaly.kind)}</span>
                      <span className="text-muted-foreground">· severity {anomaly.severity}</span>
                      <time className="tnum ml-auto text-[11px] text-muted-foreground">{fmtAgo(row.last_anomaly_at, now)}</time>
                    </div>
                    {(anomaly.trust_before !== null || anomaly.trust_after !== null) && (
                      <div className="tnum text-[13px]">
                        Trust {fmtPct(anomaly.trust_before)} → <span style={{ color }}>{fmtPct(anomaly.trust_after)}</span>
                      </div>
                    )}
                    {anomaly.top_features.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {anomaly.top_features.map((f) => (
                          <span key={f.feature} className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-[12px]">
                            {f.label}
                            <span className={cn("tnum font-mono text-[11px]", Math.abs(f.z) >= 2 ? "text-trust-suspicious" : "text-trust-watch")}>{fmtZ(f.z)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    {anomaly.explanation && <p className="text-[12.5px] leading-snug text-muted-foreground">{anomaly.explanation}</p>}
                    {ack && (
                      <div className="inline-flex items-center gap-1 text-[11.5px] text-trust-normal">
                        <CheckCheck className="size-3.5" /> Acknowledged by {ack.actor} · {fmtAgo(ack.t, now)}
                      </div>
                    )}
                  </div>
                </Section>
              )}

              {/* Actions */}
              <Section title="Admin actions">
                <div className="grid grid-cols-2 gap-2">
                  {adminLocked ? (
                    <Button variant="outline" disabled={busy !== null} onClick={() => run({ device_id: row.device_id, action: "unlock" }, "Admin lock cleared")}>
                      <LockOpen /> Clear admin lock
                    </Button>
                  ) : (
                    <Button
                      variant="destructive"
                      disabled={busy !== null || row.locked}
                      title={voiceLocked ? "Already locked by a failed voice check" : undefined}
                      onClick={() => run({ device_id: row.device_id, action: "lock" }, "Device locked")}
                    >
                      <Lock /> {voiceLocked ? "Voice-locked" : "Lock device"}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    disabled={busy !== null || row.locked || row.open_challenge !== null || !row.online}
                    onClick={() => run({ device_id: row.device_id, action: "force_reverify" }, "Re-verification requested")}
                  >
                    <AudioLines /> Force re-verify
                  </Button>
                  <Button
                    variant="outline"
                    className="col-span-2"
                    disabled={busy !== null || !anomaly || Boolean(ack)}
                    onClick={() => anomaly && run({ device_id: row.device_id, action: "ack_alert", anomaly_id: anomaly.id }, "Alert acknowledged")}
                  >
                    <CheckCheck /> {ack ? "Alert acknowledged" : anomaly ? `Acknowledge alert: ${anomalyLabel(anomaly.kind)}` : "No alert to acknowledge"}
                  </Button>
                </div>
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = note.trim();
                    if (text) void run({ device_id: row.device_id, action: "note", text }, "Note added");
                  }}
                >
                  <Input value={note} maxLength={80} onChange={(e) => setNote(e.target.value)} placeholder="Add a note to the audit trail (≤ 80 chars)" aria-label="Note" />
                  <Button type="submit" variant="secondary" disabled={busy !== null || !note.trim()}>
                    <StickyNote /> Add
                  </Button>
                </form>
                <p className="text-[11.5px] text-muted-foreground">
                  {mock
                    ? "Demo: actions run against the simulation and land in the audit trail exactly like the live API."
                    : "Every action is written to the audit trail with your handle."}
                </p>
              </Section>

              {/* Trace-back + links */}
              <div className="grid grid-cols-2 gap-2">
                <Button className="col-span-2" onClick={() => onTrace(row.device_id)}>
                  <Route /> Trace this device in the audit trail
                </Button>
                <Button asChild variant="secondary">
                  <Link href={`/dashboard?device_id=${encodeURIComponent(row.device_id)}`}>
                    <ExternalLink /> Open live dashboard
                  </Link>
                </Button>
                <Button asChild variant="secondary">
                  <Link href="/history">
                    <History /> Trace in history
                  </Link>
                </Button>
              </div>

              {/* Device audit */}
              <Section title="Recent activity on this device">
                {deviceAudit.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
                ) : (
                  <ol className="relative space-y-2.5 border-l border-border pl-4">
                    {deviceAudit.map((a) => (
                      <li key={a.id} className="relative">
                        <span className="absolute top-1.5 -left-[21px] size-2.5 rounded-full ring-2 ring-popover" style={{ background: severityColor(a.severity) }} />
                        <div className="flex items-center gap-2">
                          <KindChip kind={a.kind} />
                          <time className="tnum font-mono text-[11px] text-muted-foreground">{fmtClock(a.t)}</time>
                          {a.actor !== "system" && <span className="truncate text-[11px] text-muted-foreground">by {a.actor}</span>}
                        </div>
                        <p className="mt-0.5 text-[12.5px] leading-snug">{a.summary}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </Section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
