"use client";

import { Suspense } from "react";

import { AdminGate } from "@/components/admin/admin-gate";
import { AdminView } from "@/components/admin/admin-view";
import { useMounted } from "@/lib/hooks";
import { useMockMode } from "@/lib/mode";
import { useMe } from "@/lib/session";

function Skeleton() {
  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-4 px-4 py-5 sm:px-6">
      <div className="h-12 w-72 animate-pulse rounded-lg bg-muted/60" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="panel h-[104px] animate-pulse" />
        ))}
      </div>
      <div className="panel h-96 animate-pulse" />
    </div>
  );
}

/**
 * /admin — the org control panel (§2.4).
 * - ?mock=1 (or NEXT_PUBLIC_MOCK=1): the synthetic demo org, for anyone.
 * - an admin session: the live org (roster, audit, org socket) with a toggle to the demo.
 * - anonymous, non-admin or API down: a gate whose primary action is the demo, over a blurred preview.
 */
function Admin() {
  const mounted = useMounted();
  const mock = useMockMode();
  const { status, me } = useMe();

  if (!mounted) return <Skeleton />;
  if (mock) return <AdminView source="demo" />;
  if (status === "loading") return <Skeleton />;
  if (status === "ok" && me?.role === "admin") return <AdminView source="live" />;
  return <AdminGate status={status} me={me} />;
}

export default function AdminPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <Admin />
    </Suspense>
  );
}
