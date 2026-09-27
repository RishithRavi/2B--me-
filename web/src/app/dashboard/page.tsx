"use client";

import { ArrowLeft, FlaskConical, LogIn, SearchX, WifiOff } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";

import { DashboardView } from "@/components/dashboard/dashboard-view";
import { useDrill, useRefreshMeOnAuthClose, useResnapshotOnFirstDevice } from "@/components/dashboard/live-hooks";
import { StageView } from "@/components/dashboard/stage-view";
import { useDashboardActions } from "@/components/dashboard/use-actions";
import { useServerInfo } from "@/components/dashboard/voice-mode";
import { SIMULATED_TAKEOVER } from "@/components/landing/links";
import { EmptyState } from "@/components/site/empty-state";
import { Button } from "@/components/ui/button";
import { useLive } from "@/lib/live";
import { shortId } from "@/lib/ui";
import { useMe } from "@/lib/session";

function Dashboard() {
  const params = useSearchParams();
  const stage = params.get("stage") === "1";
  // Admin drill-in from /admin (§2.4): /dashboard?device_id=<id> focuses the stream on that device.
  const deviceParam = params.get("device_id");
  const query = params.toString();
  const here = query ? `/dashboard?${query}` : "/dashboard";
  const me = useMe();
  const { state, store, mock } = useLive({ enabled: authSettled(me.status) });
  const server = useServerInfo(mock, `${me.status}:${state.connected}`);
  const actions = useDashboardActions(store, state.device?.id ?? state.focus, { voiceStub: server.voiceMode === "stub" });
  const admin = me.me?.role === "admin";
  // An admin's drill-in names a roster row (synthetic employees get labelled, A's stage controls stay off them).
  const drill = useDrill(deviceParam && admin && !mock ? deviceParam : null);
  // A device the roster doesn't have (admin), or one the server wouldn't stream to this user (it fell back to
  // another of theirs, which the focused store ignores): say so instead of showing an empty "Learning" device.
  const notFound =
    !!deviceParam && !mock && (drill ? drill.notFound : !admin && state.connected && Object.keys(state.knownDevices).length > 0 && !state.knownDevices[deviceParam]);

  useEffect(() => {
    if (store && !mock && deviceParam) store.setFocus(deviceParam);
  }, [store, mock, deviceParam]);
  useResnapshotOnFirstDevice(state, store, mock);
  useRefreshMeOnAuthClose(state.closeCode, mock);

  if (!mock && (me.status === "anon" || state.closeCode === 4401)) {
    return (
      <div className="mx-auto w-full max-w-lg px-4 py-20">
        <div className="panel">
          <EmptyState
            icon={LogIn}
            title="Sign in as the enrolled owner to see the live device"
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button asChild size="sm">
                  {/* back here after signing in (stage view and device kept) */}
                  <Link href={`/login?next=${encodeURIComponent(here)}`}>
                    <LogIn /> Log in
                  </Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  {/* a full page load: mock mode is per tab and read on load (components/landing/links.ts) */}
                  <a href={SIMULATED_TAKEOVER}>
                    <FlaskConical /> Watch a simulated takeover
                  </a>
                </Button>
              </div>
            }
          >
            Or watch a simulated takeover — clearly labelled demo data.
          </EmptyState>
        </div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="mx-auto w-full max-w-lg px-4 py-20">
        <div className="panel">
          <EmptyState
            icon={SearchX}
            title="Device not found or not yours"
            action={
              <Button asChild size="sm" variant="outline">
                {/* full page load: the live store is still focused on the missing device */}
                <a href={admin ? "/admin" : "/dashboard"}>
                  <ArrowLeft /> {admin ? "Back to the org console" : "Open your dashboard"}
                </a>
              </Button>
            }
          >
            {admin ? "The org roster has no device " : "Your account has no device "}
            <span className="font-mono">{shortId(deviceParam)}</span>. The link may be stale.
          </EmptyState>
        </div>
      </div>
    );
  }

  const isAdmin = mock || admin;

  return (
    <>
      {me.status === "offline" && !mock && (
        <div className="mx-auto mt-4 flex w-full max-w-[1440px] items-center gap-2 px-4 text-sm text-trust-watch sm:px-6">
          <WifiOff className="size-4" /> The API is unreachable. Retrying the live stream in the background.{" "}
          <a href={SIMULATED_TAKEOVER} className="underline underline-offset-4">
            Watch a simulated takeover
          </a>
        </div>
      )}
      {stage ? (
        <StageView state={state} store={store} mock={mock} actions={actions} isAdmin={isAdmin} voiceMode={server.voiceMode} drill={drill} />
      ) : (
        <DashboardView
          state={state}
          store={store}
          mock={mock}
          actions={actions}
          isAdmin={isAdmin}
          voiceMode={server.voiceMode}
          serverBackend={server.modelBackend}
          drill={drill}
        />
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
