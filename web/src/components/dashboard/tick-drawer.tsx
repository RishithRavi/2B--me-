"use client";

import { Check, Copy, PackageOpen, RefreshCw, ShieldCheck } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { fmtAgo } from "@/lib/ui";

/** Minimal JSON syntax coloring (keys / strings / numbers / literals) without any HTML injection. */
export function highlightJson(json: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(json))) {
    if (m.index > last) out.push(json.slice(last, m.index));
    if (m[1] && m[2]) {
      out.push(
        <span key={i++} className="text-brand-2">
          {m[1]}
        </span>,
        m[2],
      );
    } else if (m[1]) {
      out.push(
        <span key={i++} className="text-trust-normal">
          {m[1]}
        </span>,
      );
    } else if (m[3]) {
      out.push(
        <span key={i++} className="text-mod-workflow">
          {m[3]}
        </span>,
      );
    } else if (m[4]) {
      out.push(
        <span key={i++} className="text-trust-locked">
          {m[4]}
        </span>,
      );
    }
    last = re.lastIndex;
  }
  if (last < json.length) out.push(json.slice(last));
  return out;
}

/** "What left this laptop": the literal last tick payload the agent sent (timing aggregates only). */
export function TickDrawer({
  tick,
  onRefresh,
  trigger,
}: {
  tick: Record<string, unknown> | null;
  onRefresh?: () => void;
  trigger?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const json = useMemo(() => (tick ? JSON.stringify(tick, null, 2) : ""), [tick]);
  const sentAt = typeof tick?.t_end === "string" ? tick.t_end : null;
  const bytes = json ? new TextEncoder().encode(JSON.stringify(tick)).length : 0;

  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <Sheet>
      <SheetTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm">
            <PackageOpen /> What left this laptop
          </Button>
        )}
      </SheetTrigger>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <PackageOpen className="size-4" /> What left this laptop
          </SheetTitle>
          <SheetDescription>
            This is the literal last payload the agent sent to 2bme.tech{sentAt ? ` (${fmtAgo(sentAt)})` : ""}. It holds only
            timing aggregates: percentiles, rates and counts per evidence block. There are no keys, no typed content, no window titles,
            no app names and no screen coordinates.
          </SheetDescription>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-trust-normal/12 px-2 py-1 text-xs text-trust-normal">
              <ShieldCheck className="size-3.5" /> anonymized on device
            </span>
            {bytes > 0 && <span className="tnum font-mono text-xs text-muted-foreground">{bytes.toLocaleString()} bytes</span>}
            <div className="ml-auto flex gap-1.5">
              {onRefresh && (
                <Button variant="ghost" size="sm" onClick={onRefresh}>
                  <RefreshCw /> Refresh
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={copy} disabled={!json}>
                {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        </SheetHeader>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-auto bg-surface">
          {json ? (
            <pre className="p-4 font-mono text-[11.5px] leading-relaxed text-muted-foreground">{highlightJson(json)}</pre>
          ) : (
            <p className="p-6 text-sm text-muted-foreground">No tick received yet. Start the agent on the laptop.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
