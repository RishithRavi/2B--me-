import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Card with a compact console-style header. */
export function Panel({
  title,
  icon: Icon,
  hint,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  icon?: LucideIcon;
  hint?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("panel flex min-w-0 flex-col", className)}>
      <header className="flex items-center gap-2 px-4 pt-3.5 pb-2">
        {Icon && <Icon className="size-4 text-muted-foreground" />}
        <h2 className="shrink-0 text-sm font-medium">{title}</h2>
        {hint && <span className="min-w-0 truncate text-xs text-muted-foreground">{hint}</span>}
        {action && <div className="ml-auto flex items-center gap-1.5">{action}</div>}
      </header>
      <div className={cn("min-h-0 flex-1 px-4 pb-4", bodyClassName)}>{children}</div>
    </section>
  );
}
