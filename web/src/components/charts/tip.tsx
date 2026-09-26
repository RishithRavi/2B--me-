import type { ReactNode } from "react";

/** Structural subset of Recharts' tooltip content props (keeps custom tooltips free of Recharts generics). */
export interface TipProps {
  active?: boolean;
  label?: unknown;
  payload?: ReadonlyArray<{
    payload?: unknown;
    value?: unknown;
    name?: unknown;
    color?: string;
    dataKey?: unknown;
  }>;
}

export function TipBox({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">{children}</div>;
}

/** Shared axis styling (recessive ink, no tick lines). */
export const AXIS_TICK = { fontSize: 10, fill: "var(--muted-foreground)" } as const;
