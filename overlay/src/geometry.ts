// Pure helpers for the overlay shell (unit-tested with node:test).

export type Mode = "pill" | "details" | "panel" | "prompt" | "lock";
export const MODES: readonly Mode[] = ["pill", "details", "panel", "prompt", "lock"];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// must match the pill in web/src/components/overlay/overlay-view.tsx (304×68 at right/top 8px)
export const PILL = { width: 320, height: 84, margin: 12 } as const;
export const PANEL = { width: 420, height: 540 } as const;
// "My behavior": the pill expanded in place (top-right). Must match BehaviorPanel (384 wide at right/top 8px).
export const DETAILS = { width: 400, height: 700 } as const;

export function isMode(x: unknown): x is Mode {
  return typeof x === "string" && (MODES as readonly string[]).includes(x);
}

/** Window bounds per mode. Full-screen modes cover the whole display (menu bar and dock included). */
export function boundsFor(mode: Mode, display: Rect, workArea: Rect): Rect {
  switch (mode) {
    case "pill":
      return {
        x: workArea.x + workArea.width - PILL.width - PILL.margin,
        y: workArea.y + PILL.margin,
        width: PILL.width,
        height: PILL.height,
      };
    case "details": {
      const height = Math.min(DETAILS.height, Math.max(PILL.height, workArea.height - 2 * PILL.margin));
      return {
        x: workArea.x + workArea.width - DETAILS.width - PILL.margin,
        y: workArea.y + PILL.margin,
        width: DETAILS.width,
        height,
      };
    }
    case "panel":
      return {
        x: Math.round(workArea.x + (workArea.width - PANEL.width) / 2),
        y: Math.round(workArea.y + (workArea.height - PANEL.height) / 2),
        width: PANEL.width,
        height: PANEL.height,
      };
    case "prompt":
    case "lock":
      return { ...display };
  }
}

/**
 * The page's mode as the shell knows it. The page can ask for a mode (a remembered "lock", say) before the window
 * is ready to show; the shell must then show that mode, never a hard-coded pill: the page sends each mode once
 * (on change) and would never correct a shell that shrank the lock screen to a pill.
 */
export class ModeSync {
  private ready = false;
  constructor(private current: Mode = "pill") {}

  get mode(): Mode {
    return this.current;
  }

  /** An IPC request from the page → the mode to apply now, or null (invalid, unchanged, or kept until ready). */
  request(next: unknown): Mode | null {
    if (!isMode(next) || next === this.current) return null;
    this.current = next;
    return this.ready ? next : null;
  }

  /** ready-to-show → the mode to apply first: the page's latest request, else the pill. */
  markReady(): Mode {
    this.ready = true;
    return this.current;
  }

  /** Display changes re-apply the current mode, but only once the window has been shown. */
  reapply(): Mode | null {
    return this.ready ? this.current : null;
  }
}

export interface OverlayArgs {
  url: string;
  dev: boolean;
  hardLock: boolean;
}

/** --url=https://2bme.tech (or TWOBME_URL), --dev, --hard-lock (or TWOBME_HARD_LOCK=1). */
export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): OverlayArgs {
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const raw = value("url") ?? env.TWOBME_URL ?? "https://2bme.tech";
  const url = new URL(raw).origin; // origin only: the shell always loads <origin>/overlay
  return { url, dev: flag("dev"), hardLock: flag("hard-lock") || env.TWOBME_HARD_LOCK === "1" };
}

export function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export interface ShellPolicy {
  /** webPreferences.devTools: DevTools can't even be opened without --dev (⌥⌘I would inspect the lock screen) */
  devTools: boolean;
  /** open detached DevTools at start (--dev --devtools) */
  openDevToolsOnStart: boolean;
  /** the app menu is removed entirely (no ⌘H hide, ⌘W close, ⌘Q quit, ⌥⌘I inspect accelerators) */
  applicationMenu: null;
}

export function shellPolicy(args: OverlayArgs, argv: readonly string[]): ShellPolicy {
  return { devTools: args.dev, openDevToolsOnStart: args.dev && argv.includes("--devtools"), applicationMenu: null };
}
