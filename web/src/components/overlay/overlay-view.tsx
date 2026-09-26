"use client";

// The on-laptop overlay (rendered at /overlay inside the Electron shell in overlay/).
//   pill    — always-on-top trust pill; red "Verify" when a voice check is waiting; click → "My behavior"
//   details — "My behavior": the pill expanded into a compact panel (still floating over other apps)
//   prompt  — a different person may be at the keyboard: full-screen voice check (dismissible — behavior alone
//             never blocks; purchases and other high-risk actions keep stepping up until it's answered)
//   lock    — the device was locked by a failed voice check: full screen, not dismissible; the owner signs in
//             again and unlocks with a fresh voice phrase (§5.4). Fails closed: offline, loading or signed out with
//             a remembered lock still shows the lock screen.
//   panel   — sign in
import { CheckCircle2, ChevronDown, Loader2, Lock, LogIn, Mic, RefreshCw, ShieldAlert, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRefreshMeOnAuthClose, useResnapshotOnFirstDevice } from "@/components/dashboard/live-hooks";
import { SimulatedBadge } from "@/components/dashboard/voice-analysis";
import { useVoiceMode, type VoiceMode } from "@/components/dashboard/voice-mode";
import { WhyChips } from "@/components/dashboard/why-chips";
import { LogoMark } from "@/components/site/logo";
import { Button } from "@/components/ui/button";
import { ChallengeFlow as RealChallengeFlow } from "@/components/voice/challenge-flow";
import { ChallengeFlow as MockChallengeFlow } from "@/components/verify-stub/challenge-flow";
import { mockBackend, realBackend } from "@/components/verify-stub/backend";
import { ApiError } from "@/lib/api";
import type { ChallengeLive, Level, TrustPoint, VoiceDecision } from "@/lib/contracts";
import { useMounted, useNow } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { refreshMe, useMe } from "@/lib/session";
import { levelColor, levelLabel } from "@/lib/ui";
import { cn } from "@/lib/utils";

import { BehaviorPanel } from "./behavior-panel";
import { type OverlayMode, inElectron, overlayBridge } from "./bridge";
import { OverlaySignIn } from "./sign-in";
import { type MeStatus, challengeKey, fullScreen, overlayMode, promptable, settleAfterPrompt, SETTLE_MS } from "./overlay-state";

// The simulated stream never shares the real lock memory (a mock lock must not lock the real overlay).
const lockKey = (mock: boolean) => (mock ? "2bme:overlay:locked:mock" : "2bme:overlay:locked");

/** What the overlay remembers about a lock (so a revoked, restarted or offline overlay still explains it). */
export interface LockMemory {
  reason: string | null;
  label: string | null;
}

/** null = not locked. Any unreadable value counts as locked (fail closed). */
export function parseLockMemory(raw: string | null): LockMemory | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    return { reason: typeof o.reason === "string" ? o.reason : null, label: typeof o.label === "string" ? o.label : null };
  } catch {
    return { reason: null, label: null };
  }
}

function readLock(mock: boolean): LockMemory | null {
  try {
    return parseLockMemory(window.localStorage.getItem(lockKey(mock)));
  } catch {
    return null;
  }
}

function writeLock(mock: boolean, v: LockMemory | null) {
  try {
    if (v) window.localStorage.setItem(lockKey(mock), JSON.stringify(v));
    else window.localStorage.removeItem(lockKey(mock));
  } catch {
    /* storage unavailable: the lock screen still follows live state */
  }
}

const LOCK_REASON: Record<string, string> = {
  voice_spoof: "A synthetic (cloned) voice answered the voice check.",
  voice_impostor: "The voice that answered didn't match the owner.",
  lock: "The TOTP fallback failed.",
  admin_lock: "An administrator locked this device.",
};

/** ?dev=1 (the shell passes it with --dev) shows the stub's demo-decision controls. Always called (hook order). */
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

export function OverlayView() {
  const me = useMe();
  const mounted = useMounted();
  const devFlag = useDevFlag();
  const signedIn = me.status === "ok" || me.mock;
  const { state, store, mock } = useLive({ enabled: signedIn });
  const voiceMode = useVoiceMode(mock);
  const now = useNow(1000);
  const [lockMemo, setLockMemo] = useState<LockMemory | null | undefined>(undefined); // undefined = not read yet
  const [snoozedKey, setSnoozedKey] = useState<string | null>(null);
  const [wantPanel, setWantPanel] = useState(false);
  const [wantDetails, setWantDetails] = useState(false);
  const [closed, setClosed] = useState<ChallengeLive | null>(null);
  const [replies, setReplies] = useState<Record<string, VoiceDecision>>({});
  const devControls = mock || process.env.NODE_ENV === "development" || devFlag;

  useResnapshotOnFirstDevice(state, store, mock);
  useRefreshMeOnAuthClose(state.closeCode, mock);

  const meStatus: MeStatus = me.mock ? "ok" : me.status;
  const serverLocked = !!(state.device?.locked || state.trust?.locked || state.trust?.level === "locked");
  const synced = signedIn && state.device !== null;
  const memo = lockMemo !== undefined ? lockMemo : mounted ? readLock(mock) : null;
  const lastKnownLocked = memo !== null;
  const remember = useCallback(
    (v: LockMemory | null) => {
      writeLock(mock, v);
      setLockMemo(v);
    },
    [mock],
  );

  const challenge = state.open_challenge;
  const decisionFor = (id: string): VoiceDecision | null =>
    replies[id] ?? state.voiceResults.find((r) => r.challenge_id === id)?.decision ?? null;
  // A prompt we were showing just closed (terminal challenge event): hold full screen until the outcome is known,
  // so the shell goes prompt → lock directly instead of prompt → pill → lock. Derived during render (not in an
  // effect) so the very render that loses the challenge never reports "pill" to the shell.
  const shownPrompt = useRef<ChallengeLive | null>(null);
  const prevPrompt = shownPrompt.current; // the previous render's prompt (read during render on purpose)
  const justClosed = prevPrompt && (!challenge || challenge.challenge_id !== prevPrompt.challenge_id) ? prevPrompt : null;
  const closedCh = justClosed ?? closed;
  const settling = closedCh ? settleAfterPrompt(closedCh, decisionFor(closedCh.challenge_id)) : null;

  const mode = overlayMode({
    meStatus,
    locked: serverLocked,
    lastKnownLocked,
    synced,
    challenge,
    snoozedKey,
    wantPanel,
    wantDetails,
    settling,
  });

  useEffect(() => {
    if (justClosed) setClosed(justClosed);
    shownPrompt.current = mode === "prompt" && promptable(challenge) ? challenge : null;
  });
  useEffect(() => {
    if (!closed) return;
    const id = setTimeout(() => setClosed(null), SETTLE_MS);
    return () => clearTimeout(id);
  }, [closed]);

  // Lock memory. BLOCK_* on a proactive/step-up check locks the device (§5.4): remember it right away, before the
  // session is revoked. Otherwise the owner's live device is authoritative: remember its lock state across
  // revocations, restarts and outages.
  const deviceLabel = state.device?.label ?? null;
  const deviceReason = state.device?.lock_reason ?? null;
  const settledReason = settling === "lock" && closedCh ? blockReason(decisionFor(closedCh.challenge_id)) : null;
  useEffect(() => {
    if (settling === "lock") {
      if (!memo) remember({ reason: settledReason, label: deviceLabel });
      return;
    }
    if (!synced) return;
    if (!serverLocked) {
      if (memo) remember(null);
      return;
    }
    const want = { reason: deviceReason ?? memo?.reason ?? null, label: deviceLabel ?? memo?.label ?? null };
    if (!memo || memo.reason !== want.reason || memo.label !== want.label) remember(want);
  }, [settling, settledReason, synced, serverLocked, deviceReason, deviceLabel, memo, remember]);

  useEffect(() => {
    if (mounted) overlayBridge()?.setMode(mode);
  }, [mode, mounted]);

  useEffect(() => {
    if (me.status === "ok") setWantPanel(false);
  }, [me.status]);
  useEffect(() => {
    if (fullScreen(mode)) setWantDetails(false);
  }, [mode]);
  useEffect(() => {
    if (mode !== "details") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWantDetails(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  const onSignedIn = useCallback(() => {
    store?.reconnect();
    setWantPanel(false);
  }, [store]);

  const onReply = useCallback((id: string, d: VoiceDecision) => setReplies((r) => ({ ...r, [id]: d })), []);

  const backend = mock ? mockBackend : realBackend;
  const lastVerify = state.voiceResults.find((r) => r.decision === "VERIFY");
  const justVerified = !!lastVerify && now - Date.parse(lastVerify.t) < 8000;
  const dashboardHref = mock ? "/dashboard?mock=1" : "/dashboard";
  const learning = !state.model || state.model.status !== "ready" || state.device?.mode === "enroll";

  // Nothing until hydrated: the lock memory lives in localStorage, and the first frame must not be a pill.
  if (!mounted) return <OverlayFrame mode="pill">{null}</OverlayFrame>;

  return (
    <OverlayFrame mode={mode}>
      {mode === "pill" && (
        <Pill
          display={state.trust?.display ?? null}
          level={serverLocked ? "locked" : learning && state.trust ? "learning" : (state.trust?.level ?? null)}
          history={state.trust_history}
          connected={state.connected}
          hasDevice={state.device !== null}
          meStatus={meStatus}
          waiting={promptable(challenge) ? () => setSnoozedKey(null) : null}
          verified={justVerified}
          onSignIn={() => setWantPanel(true)}
          onExpand={() => setWantDetails(true)}
        />
      )}
      {mode === "details" && (
        <BehaviorPanel state={state} onClose={() => setWantDetails(false)} dashboardHref={dashboardHref} fill={inElectron()} />
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
      {mode === "prompt" && (
        <FullScreen tone="prompt">
          <Card wide>
            <Header
              icon={<ShieldAlert className="size-6 text-trust-suspicious" />}
              title="Is this still the owner?"
              sub={`Typing and pointer rhythm stopped matching the enrolled profile (trust ${state.trust ? `${state.trust.display}%` : "—"}). Behavior alone never blocks — answer a quick voice check to continue.`}
              badge={voiceMode === "stub" ? <SimulatedBadge /> : null}
            />
            {promptable(challenge) ? (
              <>
                <div className="mb-4">
                  <WhyChips blocks={state.blocks} limit={4} />
                </div>
                {mock ? (
                  <MockChallengeFlow
                    key={challengeKey(challenge) ?? ""}
                    challengeId={challenge.challenge_id}
                    decisionId={null}
                    backend={backend}
                    devControls={devControls}
                  />
                ) : (
                  <RealChallengeFlow
                    key={challengeKey(challenge) ?? ""}
                    challengeId={challenge.challenge_id}
                    onDone={(res) => onReply(challenge.challenge_id, res.result.decision)}
                  />
                )}
                <div className="mt-4 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>Until you verify, purchases and other high-risk actions keep asking for a step-up.</span>
                  <Button variant="ghost" size="sm" onClick={() => setSnoozedKey(challengeKey(challenge))}>
                    Not now
                  </Button>
                </div>
              </>
            ) : (
              <div role="status" className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Checking the result of the voice check…
              </div>
            )}
          </Card>
        </FullScreen>
      )}
      {mode === "lock" && (
        <FullScreen tone="lock">
          <LockScreen
            meStatus={meStatus}
            reason={deviceReason ?? settledReason ?? memo?.reason ?? null}
            deviceLabel={deviceLabel ?? memo?.label ?? "This Mac"}
            backend={backend}
            devControls={devControls}
            voiceMode={voiceMode}
            onSignedIn={onSignedIn}
            onNotLocked={() => {
              remember(null);
              store?.reconnect();
            }}
          />
        </FullScreen>
      )}
    </OverlayFrame>
  );
}

function blockReason(d: VoiceDecision | null): string | null {
  return d === "BLOCK_SPOOF" ? "voice_spoof" : d === "BLOCK_IMPOSTOR" ? "voice_impostor" : null;
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

function Header({ icon, title, sub, badge }: { icon: React.ReactNode; title: string; sub?: string; badge?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-start gap-3">
      <div className="mt-0.5 rounded-xl border border-border bg-muted/40 p-2">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {badge}
        </div>
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
  if (!pts) return <div className="h-7 min-w-0 flex-1" />;
  return (
    <svg viewBox="0 0 90 28" preserveAspectRatio="none" className="h-7 min-w-0 flex-1" aria-hidden>
      <line x1="0" x2="90" y1={27 - 0.8 * 26} y2={27 - 0.8 * 26} stroke="var(--trust-normal)" strokeOpacity="0.22" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
      <line x1="0" x2="90" y1={27 - 0.4 * 26} y2={27 - 0.4 * 26} stroke="var(--trust-suspicious)" strokeOpacity="0.22" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Pill({
  display,
  level,
  history,
  connected,
  hasDevice,
  meStatus,
  waiting,
  verified,
  onSignIn,
  onExpand,
}: {
  display: number | null;
  level: Level | null;
  history: TrustPoint[];
  connected: boolean;
  hasDevice: boolean;
  meStatus: MeStatus;
  waiting: (() => void) | null;
  verified: boolean;
  onSignIn: () => void;
  onExpand: () => void;
}) {
  const color = levelColor(level);
  const body = (() => {
    if (meStatus === "loading") {
      return (
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Connecting to 2bME…
        </div>
      );
    }
    if (meStatus !== "ok") {
      return (
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
      );
    }
    if (!hasDevice) {
      return (
        <div className="min-w-0 flex-1 text-sm leading-tight">
          <div className="font-medium">{connected ? "Waiting for this Mac" : "Connecting…"}</div>
          <div className="text-xs text-muted-foreground">{connected ? "start the 2bME agent to begin" : "opening the live stream"}</div>
        </div>
      );
    }
    return (
      <>
        <button
          type="button"
          onClick={onExpand}
          title="My behavior"
          aria-label="Open My behavior"
          className="overlay-no-drag group flex min-w-0 flex-1 items-center gap-3 rounded-xl py-1 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="w-[62px] shrink-0 leading-none">
            <div className="tnum text-2xl font-semibold" style={{ color }}>
              {display === null ? "—" : `${Math.min(99, display)}%`}
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
          {!waiting && <ChevronDown className="size-4 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100" />}
        </button>
        {waiting && (
          <Button size="sm" variant="destructive" className="overlay-no-drag ml-auto" onClick={waiting}>
            <Mic className="size-3.5" /> Verify
          </Button>
        )}
      </>
    );
  })();
  return (
    <div
      className={cn(
        "overlay-drag absolute right-2 top-2 flex h-[68px] w-[304px] items-center gap-3 rounded-2xl border bg-background/92 px-3.5 shadow-xl backdrop-blur-md",
        waiting ? "border-trust-suspicious/70 ring-2 ring-trust-suspicious/40" : "border-border",
      )}
    >
      <LogoMark className="size-6 shrink-0" />
      {body}
    </div>
  );
}

function LockScreen({
  meStatus,
  reason,
  deviceLabel,
  backend,
  devControls,
  voiceMode,
  onSignedIn,
  onNotLocked,
}: {
  meStatus: MeStatus;
  reason: string | null;
  deviceLabel: string;
  backend: typeof realBackend;
  devControls: boolean;
  voiceMode: VoiceMode;
  onSignedIn: () => void;
  onNotLocked: () => void;
}) {
  const [unlockId, setUnlockId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [retrying, setRetrying] = useState(false);

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
        onNotLocked();
      } else {
        setErr(e instanceof ApiError ? e.detail || `HTTP ${e.status}` : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setRetrying(true);
    try {
      await refreshMe();
    } finally {
      setRetrying(false);
    }
  }

  const offline = meStatus === "offline";
  const connecting = meStatus === "loading";
  const showLogin = !offline && !connecting && (meStatus !== "ok" || needsLogin);

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
        {offline || connecting ? (
          <div className="mx-auto flex max-w-sm flex-col items-center gap-3 rounded-2xl border border-border bg-card p-6 text-center">
            {offline ? <WifiOff className="size-5 text-muted-foreground" /> : <Loader2 className="size-5 animate-spin text-muted-foreground" />}
            <p className="text-sm text-muted-foreground">
              {offline
                ? "Can't reach 2bME. The lock holds until the owner verifies: it never opens because the network is down."
                : "Checking the lock with 2bME…"}
            </p>
            {offline && (
              <Button variant="outline" size="sm" onClick={() => void retry()} disabled={retrying}>
                {retrying ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Try again
              </Button>
            )}
          </div>
        ) : showLogin ? (
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
            {voiceMode === "stub" && (
              <div className="mb-4 flex justify-end">
                <SimulatedBadge />
              </div>
            )}
            {backend.mock ? (
              <MockChallengeFlow challengeId={unlockId} decisionId={null} backend={backend} devControls={devControls} />
            ) : (
              <RealChallengeFlow challengeId={unlockId} />
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <Button size="lg" onClick={startUnlock} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Mic className="size-4" />} Unlock with voice
            </Button>
            {voiceMode === "stub" && <SimulatedBadge />}
            {err && <p className="text-sm text-trust-suspicious">{err}</p>}
          </div>
        )}
      </div>
      <p className="mt-10 text-xs text-muted-foreground">2bME · behavior raised the alarm; the voice check decided.</p>
    </div>
  );
}
