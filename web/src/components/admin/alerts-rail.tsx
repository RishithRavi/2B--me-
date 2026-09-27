"use client";

// Live alerts rail: every audit row at severity ≥ 3, newest first, with acknowledgement state.
import { AnimatePresence, motion } from "framer-motion";
import { BellRing, CheckCheck, ShieldCheck } from "lucide-react";

import { Panel } from "@/components/site/panel";
import type { AuditRow } from "@/lib/contracts";
import { auditKindLabel } from "@/lib/org-live";
import { fmtAgo } from "@/lib/ui";
import { cn } from "@/lib/utils";

import { KIND_META, severityColor } from "./org-bits";

export function AlertsRail({
  alerts,
  acked,
  now,
  onSelect,
  className,
}: {
  alerts: AuditRow[];
  acked: ReadonlyMap<string, AuditRow>;
  now: number;
  onSelect: (deviceId: string) => void;
  className?: string;
}) {
  const open = alerts.filter((a) => !(a.ref_id && acked.has(a.ref_id))).length;
  return (
    <Panel
      title="Alerts"
      icon={BellRing}
      hint="live · severity ≥ 3"
      className={className}
      bodyClassName="flex min-h-0 flex-col px-2 pb-2"
      action={
        <span
          className={cn(
            "tnum rounded-full px-2 py-0.5 text-[11px] font-medium",
            open ? "bg-trust-suspicious/15 text-trust-suspicious" : "bg-muted text-muted-foreground",
          )}
        >
          {open} open
        </span>
      }
    >
      {alerts.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center text-sm text-muted-foreground">
          <ShieldCheck className="size-6 text-trust-normal" />
          All quiet. Alerts appear here the moment an employee deviates.
        </div>
      ) : (
        <ol className="scrollbar-thin min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          <AnimatePresence initial={false}>
            {alerts.map((a) => {
              const meta = KIND_META[a.kind] ?? KIND_META.alert;
              const Icon = meta.icon;
              const ack = a.ref_id ? acked.get(a.ref_id) : undefined;
              const color = severityColor(a.severity);
              return (
                <motion.li
                  key={a.id}
                  layout="position"
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.22 }}
                >
                  <button
                    type="button"
                    disabled={!a.device_id}
                    onClick={() => a.device_id && onSelect(a.device_id)}
                    className={cn(
                      "group grid w-full grid-cols-[3px_minmax(0,1fr)] gap-3 rounded-lg p-2.5 text-left transition-colors hover:bg-muted/50",
                      ack && "opacity-60",
                    )}
                  >
                    <span className="rounded-full" style={{ background: color }} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-[13px]">
                        <Icon className="size-3.5 shrink-0" style={{ color: meta.color }} />
                        <span className="truncate font-medium">{a.handle ?? "Org"}</span>
                        <span className="shrink-0 text-muted-foreground">· {auditKindLabel(a.kind)}</span>
                        <time className="tnum ml-auto shrink-0 text-[11px] text-muted-foreground">{fmtAgo(a.t, now)}</time>
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-muted-foreground">{a.summary}</span>
                      {ack && (
                        <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-trust-normal">
                          <CheckCheck className="size-3" /> Acknowledged by {ack.actor}
                        </span>
                      )}
                    </span>
                  </button>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ol>
      )}
    </Panel>
  );
}
