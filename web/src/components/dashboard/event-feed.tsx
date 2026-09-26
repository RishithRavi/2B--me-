"use client";

import { AnimatePresence, motion } from "framer-motion";

import type { FeedItem } from "@/lib/contracts";
import { feedTone, fmtClock, toneColor } from "@/lib/ui";
import { cn } from "@/lib/utils";

export function EventFeed({ items, large = false, className }: { items: FeedItem[]; large?: boolean; className?: string }) {
  if (!items.length) {
    return <p className={cn("py-3 text-sm text-muted-foreground", className)}>No events yet.</p>;
  }
  // Stable keys: identical lines (same t/type/text) get an occurrence suffix counted from the oldest.
  const seen = new Map<string, number>();
  const keys = [...items].reverse().map((it) => {
    const base = `${it.t}|${it.type}|${it.text}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}|${n}`;
  }).reverse();
  return (
    <ol className={cn("scrollbar-thin space-y-0.5 overflow-y-auto pr-1", className)}>
      <AnimatePresence initial={false}>
        {items.map((it, i) => {
          const tone = feedTone(it.severity);
          const color = toneColor(tone);
          return (
            <motion.li
              key={keys[i]}
              layout="position"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className={cn(
                "grid grid-cols-[auto_auto_1fr] items-baseline gap-2.5 rounded-md px-2 py-1.5",
                tone === "alert" && "bg-trust-suspicious/8",
                large ? "text-base" : "text-[13px]",
              )}
            >
              <time className={cn("tnum font-mono text-muted-foreground", large ? "text-sm" : "text-[11px]")}>{fmtClock(it.t)}</time>
              <span className="size-1.5 translate-y-[-1px] self-center rounded-full" style={{ background: color }} />
              <span className={cn(tone === "info" ? "text-muted-foreground" : "text-foreground")}>{it.text}</span>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );
}
