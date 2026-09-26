"use client";

// The on-laptop overlay (rendered at /overlay inside the Electron shell in overlay/).
//   pill   — always-on-top trust pill; red "Verify" when a voice check is waiting
//   prompt — a different person may be at the keyboard: full-screen voice check (dismissible — behavior alone
//            never blocks; purchases and other high-risk actions keep stepping up until it's answered)
//   lock   — the device was locked by a failed voice check: full screen, not dismissible; the owner signs in
//            again and unlocks with a fresh voice phrase (§5.4)
//   panel  — sign in
import { CheckCircle2, Loader2, Lock, LogIn, Mic, ShieldAlert, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { WhyChips } from "@/components/dashboard/why-chips";
import { LogoMark } from "@/components/site/logo";
import { Button } from "@/components/ui/button";
import { ChallengeFlow } from "@/components/verify-stub/challenge-flow";
import { mockBackend, realBackend } from "@/components/verify-stub/backend";
import { ApiError } from "@/lib/api";
import type { TrustPoint } from "@/lib/contracts";
import { useNow } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { useMe } from "@/lib/session";
import { levelColor, levelLabel } from "@/lib/ui";
import { cn } from "@/lib/utils";

import { type OverlayMode, overlayBridge } from "./bridge";
import { OverlaySignIn } from "./sign-in";
import { challengeKey, overlayMode, promptable } from "./overlay-state";

const LOCK_KEY = "2bme:overlay:locked";

function readLocked(): boolean {
  try {
    return window.localStorage.getItem(LOCK_KEY) === "1";
  } catch {
    return false;
  }
}

function writeLocked(v: boolean) {
  try {
    if (v) window.localStorage.setItem(LOCK_KEY, "1");
    else window.localStorage.removeItem(LOCK_KEY);
  } catch {
    /* storage unavailable: the lock screen still follows live state */
  }
}

const LOCK_REASON: Record<string, string> = {
  voice_spoof: "A synthetic (cloned) voice answered the voice check.",
  voice_impostor: "The voice that answered didn't match the owner.",
  lock: "The TOTP fallback failed.",
};

export function OverlayView() {
  const me = useMe();
  const { state, store, mock } = useLive({ enabled: me.status === "ok" || me.mock });
  const now = useNow(1000);
  const [lastKnownLocked, setLastKnownLocked] = useState(false);
  const [snoozedKey, setSnoozedKey] = useState<string | null>(null);
  const [wantPanel, setWantPanel] = useState(false);
  const devControls = mock || process.env.NODE_ENV === "development" || useDevFlag();

  useEffect(() => setLastKnownLocked(readLocked()), []);
  const locked = !!state.device?.locked;
  useEffect(() => {
    if (!state.device) return;
    writeLocked(locked);
    setLastKnownLocked(locked);
  }, [locked, state.device]);

  const challenge = state.open_challenge;
  const mode = overlayMode({
    meStatus: me.mock ? "ok" : me.status,
    locked,
    lastKnownLocked,
    challenge,
    snoozedKey,
    wantPanel,
  });

  useEffect(() => {
    overlayBridge()?.setMode(mode);
  }, [mode]);

  useEffect(() => {
    if (me.status === "ok") setWantPanel(false);
  }, [me.status]);

  const onSignedIn = useCallback(() => {
    store?.reconnect();
    setWantPanel(false);
  }, [store]);

  const backend = mock ? mockBackend : realBackend;
  const lastVerify = state.voiceResults.find((r) => r.decision === "VERIFY");
  const justVerified = !!lastVerify && now - Date.parse(lastVerify.t) < 8000;

  return (
    <OverlayFrame mode={mode}>
      {mode === "pill" && (
        <Pill
          display={state.trust?.display ?? null}
          level={state.trust?.level ?? null}
          history={state.trust_history}
          connected={state.connected}
          meStatus={me.mock ? "ok" : me.status}
          waiting={promptable(challenge) ? () => setSnoozedKey(null) : null}
          verified={justVerified}
          onSignIn={() => setWantPanel(true)}
        />
      )}
      {mode === "panel" && (
        <Card>
          <Header icon={<LogIn className="size-5" />} title="Sign in to 2bME" sub="The overlay shows this Mac's live trust and runs voice checks." />
          <OverlaySignIn onDone={onSignedIn} />
          <Button variant="ghost" className="mt-2 w-full" onClick={() => setWantPanel(false)}>
            Cancel
          </Button>
        </Card>
      )}
      {mode === "prompt" && promptable(challenge) && (
        <FullScreen tone="prompt">
          <Card wide>
            <Header
              icon={<ShieldAlert className="size-6 text-trust-suspicious" />}
              title="Is this still the owner?"
              sub={`Typing and pointer rhythm stopped matching the enrolled profile (trust ${state.trust ? `${state.trust.display}%` : "—"}). Behavior alone never blocks — answer a quick voice check to continue.`}
            />
            <div className="mb-4">
              <WhyChips blocks={state.blocks} limit={4} />
            </div>
            <ChallengeFlow
              key={challengeKey(challenge) ?? ""}
              challengeId={challenge.challenge_id}
              decisionId={null}
              backend={backend}
              devControls={devControls}
            />
            <div className="mt-4 flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>Until you verify, purchases and other high-risk actions keep asking for a step-up.</span>
              <Button variant="ghost" size="sm" onClick={() => setSnoozedKey(challengeKey(challenge))}>
                Not now
              </Button>
            </div>
          </Card>
        </FullScreen>
      )}
      {mode === "lock" && (
        <FullScreen tone="lock">
          <LockScreen
            signedIn={me.status === "ok" || me.mock}
            reason={state.device?.lock_reason ?? null}
            deviceLabel={state.device?.label ?? "This Mac"}
            backend={backend}
            devControls={devControls}
            onSignedIn={onSignedIn}
          />
        </FullScreen>
      )}
    </OverlayFrame>
  );
}

function useDevFlag(): boolean {
  const [dev, setDev] = useState(false);
  useEffect(() => {
    try {
      setDev(new URLSearchParams(window.location.search).get("dev") === "1");
    } catch {
      setDev(false);
    }
  }, []);
  return dev;
}

// ---------------------------------------------------------------------------------------------------------

function OverlayFrame({ mode, children }: { mode: OverlayMode; children: React.ReactNode }) {
  return (
    <div data-overlay-mode={mode} className={cn("fixed inset-0", mode === "panel" && "flex items-center justify-center p-3")}>
      {children}
    </div>
  );
}

function FullScreen({ tone, children }: { tone: "prompt" | "lock"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "fixed inset-0 flex items-center justify-center overflow-y-auto p-6",
        tone === "prompt" ? "bg-black/65 backdrop-blur-md" : "bg-[#06070a]",
      )}
    >
      {children}
    </div>
  );
}

function Card({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div
      className={cn(
        "w-full rounded-2xl border border-border bg-card/95 p-6 text-card-foreground shadow-2xl",
        wide ? "max-w-3xl" : "max-w-sm",
      )}
    >
      {children}
    </div>
  );
}

function Header({ icon, title, sub }: { icon: React.ReactNode; title: string; sub?: string }) {
  return (
    <div className="mb-5 flex items-start gap-3">
      <div className="mt-0.5 rounded-xl border border-border bg-muted/40 p-2">{icon}</div>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {sub && <p className="mt-1 text-sm text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}

function Sparkline({ history, color }: { history: TrustPoint[]; color: string }) {
  const pts = useMemo(() => {
    const recent = history.slice(-36);
    if (recent.length < 2) return "";
    return recent.map((p, i) => `${(i / (recent.length - 1)) * 88 + 1},${27 - p.confidence * 26}`).join(" ");
  }, [history]);
  if (!pts) return <div className="h-7 w-[90px]" />;
  return (
    <svg width="90" height="28" viewBox="0 0 90 28" className="shrink-0" aria-hidden>
      <line x1="0" x2="90" y1={27 - 0.4 * 26} y2={27 - 0.4 * 26} stroke="currentColor" strokeOpacity="0.15" strokeDasharray="2 3" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Pill({
  display,
  level,
  history,
  connected,
  meStatus,
  waiting,
  verified,
  onSignIn,
}: {
  display: number | null;
  level: Parameters<typeof levelColor>[0];
  history: TrustPoint[];
  connected: boolean;
  meStatus: string;
  waiting: (() => void) | null;
  verified: boolean;
  onSignIn: () => void;
}) {
  const color = levelColor(level);
  return (
    <div
      className={cn(
        "overlay-drag absolute right-2 top-2 flex h-[68px] w-[304px] items-center gap-3 rounded-2xl border bg-background/92 px-3.5 shadow-xl backdrop-blur-md",
        waiting ? "border-trust-suspicious/70 ring-2 ring-trust-suspicious/40" : "border-border",
      )}
    >
      <LogoMark className="size-6 shrink-0" />
      {meStatus !== "ok" ? (
        <>
          <div className="min-w-0 flex-1 text-sm leading-tight">
            <div className="font-medium">{meStatus === "offline" ? "2bME offline" : "2bME"}</div>
            <div className="text-xs text-muted-foreground">{meStatus === "offline" ? "can't reach the API" : "sign in to watch this Mac"}</div>
          </div>
          {meStatus === "offline" ? (
            <WifiOff className="size-4 text-muted-foreground" />
          ) : (
            <Button size="sm" className="overlay-no-drag" onClick={onSignIn}>
              Sign in
            </Button>
          )}
        </>
      ) : (
        <>
          <div className="w-[62px] shrink-0 leading-none">
            <div className="tnum text-2xl font-semibold" style={{ color }}>
              {display === null ? "—" : `${display}%`}
            </div>
            <div className="mt-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              <span className={cn("size-1.5 rounded-full", connected ? "" : "animate-pulse")} style={{ background: connected ? color : "var(--muted-foreground)" }} />
              {connected ? levelLabel(level) : "reconnecting"}
            </div>
          </div>
          {verified ? (
            <div className="flex flex-1 items-center gap-1.5 text-xs text-trust-normal">
              <CheckCircle2 className="size-4" /> Verified — welcome back
            </div>
          ) : (
            <Sparkline history={history} color={color} />
          )}
          {waiting && (
            <Button size="sm" variant="destructive" className="overlay-no-drag ml-auto" onClick={waiting}>
              <Mic className="size-3.5" /> Verify
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function LockScreen({
  signedIn,
  reason,
  deviceLabel,
  backend,
  devControls,
  onSignedIn,
}: {
  signedIn: boolean;
  reason: string | null;
  deviceLabel: string;
  backend: typeof realBackend;
  devControls: boolean;
  onSignedIn: () => void;
}) {
  const [unlockId, setUnlockId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);

  async function startUnlock() {
    setBusy(true);
    setErr(null);
    try {
      const ch = await backend.createUnlock();
      setUnlockId(ch.challenge_id);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setNeedsLogin(true);
        setErr(e.status === 403 ? "Sign in again: unlocking needs a session started after the lock." : null);
      } else if (e instanceof ApiError && e.status === 409) {
        setErr("The device isn't locked anymore.");
      } else {
        setErr(e instanceof ApiError ? e.detail || `HTTP ${e.status}` : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  const showLogin = !signedIn || needsLogin;

  return (
    <div className="w-full max-w-3xl text-center">
      <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-2xl border border-trust-locked/40 bg-trust-locked/15">
        <Lock className="size-8 text-trust-locked" />
      </div>
      <h1 className="text-3xl font-semibold tracking-tight">{deviceLabel} is locked</h1>
      <p className="mx-auto mt-2 max-w-lg text-muted-foreground">
        {(reason && LOCK_REASON[reason]) || "A voice check failed."} The session was signed out. Only the owner can unlock it, with a
        fresh voice phrase.
      </p>
      <div className="mx-auto mt-8 max-w-3xl text-left">
        {showLogin ? (
          <div className="mx-auto max-w-sm rounded-2xl border border-border bg-card p-6">
            <OverlaySignIn
              hint="Sign in as the owner to unlock with your voice."
              onDone={() => {
                setNeedsLogin(false);
                setErr(null);
                onSignedIn();
              }}
            />
            {err && <p className="mt-3 text-sm text-trust-suspicious">{err}</p>}
          </div>
        ) : unlockId ? (
          <div className="rounded-2xl border border-border bg-card p-6">
            <ChallengeFlow challengeId={unlockId} decisionId={null} backend={backend} devControls={devControls} />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <Button size="lg" onClick={startUnlock} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Mic className="size-4" />} Unlock with voice
            </Button>
            {err && <p className="text-sm text-trust-suspicious">{err}</p>}
          </div>
        )}
      </div>
      <p className="mt-10 text-xs text-muted-foreground">2bME · behavior raised the alarm; the voice check decided.</p>
    </div>
  );
}
