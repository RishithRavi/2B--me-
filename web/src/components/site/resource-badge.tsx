"use client";

import { CloudOff, DatabaseBackup, FlaskConical, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Resource } from "@/lib/resource";
import { fmtAgo } from "@/lib/ui";

/** Small status badge for a useResource() payload: loading / cached (degraded) / sample / offline. */
export function ResourceBadge<T>({ res }: { res: Resource<T> }) {
  if (res.status === "loading") {
    return (
      <Badge variant="outline" className="gap-1 text-muted-foreground">
        <Loader2 className="animate-spin" /> loading
      </Badge>
    );
  }
  if (res.status === "cached") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="gap-1 border-trust-watch/45 text-trust-watch">
            <DatabaseBackup /> cached {fmtAgo(res.cachedAt)}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>Live request failed ({res.error}). Showing the last good copy from this browser.</TooltipContent>
      </Tooltip>
    );
  }
  if (res.status === "sample") {
    return (
      <Badge variant="outline" className="gap-1 border-trust-watch/45 text-trust-watch">
        <FlaskConical /> sample data
      </Badge>
    );
  }
  if (res.status === "error") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="gap-1 border-trust-suspicious/45 text-trust-suspicious">
            <CloudOff /> unavailable
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{res.error}</TooltipContent>
      </Tooltip>
    );
  }
  return null;
}
