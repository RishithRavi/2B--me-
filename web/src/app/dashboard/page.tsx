"use client";

import { FlaskConical, LogIn, WifiOff } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { DashboardView } from "@/components/dashboard/dashboard-view";
import { StageView } from "@/components/dashboard/stage-view";
import { useDashboardActions } from "@/components/dashboard/use-actions";
import { EmptyState } from "@/components/site/empty-state";
import { Button } from "@/components/ui/button";
import { useLive } from "@/lib/live";
import { useMe } from "@/lib/session";

function Dashboard() {
  const params = useSearchParams();
  const stage = params.get("stage") === "1";
  const me = useMe();
  const { state, store, mock } = useLive({ enabled: authSettled(me.status) });
  const actions = useDashboardActions(store, state.device?.id ?? state.focus);

  if (!mock && (me.status === "anon" || state.closeCode === 4401)) {
    return (
      <div className="mx-auto w-full max-w-lg px-4 py-20">
        <div className="panel">
          <EmptyState
            icon={LogIn}
            title="Sign in to see your live trust"
            action={
              <div className="flex gap-2">
                <Button asChild size="sm">
                  <Link href="/login">
                    <LogIn /> Log in
                  </Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href="/dashboard?mock=1">
                    <FlaskConical /> Simulated stream
                  </Link>
                </Button>
              </div>
            }
          >
            The dashboard streams your devices&apos; trust over a cookie-authenticated WebSocket.
          </EmptyState>
        </div>
      </div>
    );
  }

  const isAdmin = mock || me.me?.role === "admin";

  return (
    <>
      {me.status === "offline" && !mock && (
        <div className="mx-auto mt-4 flex w-full max-w-[1440px] items-center gap-2 px-4 text-sm text-trust-watch sm:px-6">
          <WifiOff className="size-4" /> The API is unreachable. Retrying the live stream in the background.{" "}
          <Link href="/dashboard?mock=1" className="underline underline-offset-4">
            Use the simulated stream
          </Link>
        </div>
      )}
      {stage ? (
        <StageView state={state} mock={mock} actions={actions} />
      ) : (
        <DashboardView state={state} store={store} mock={mock} actions={actions} isAdmin={isAdmin} />
      )}
    </>
  );
}

/** Connect once auth is known (mock mode never waits). */
function authSettled(status: ReturnType<typeof useMe>["status"]): boolean {
  return status !== "loading" && status !== "anon";
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="mx-auto h-96 w-full max-w-[1440px] animate-pulse px-6 py-6" />}>
      <Dashboard />
    </Suspense>
  );
}
