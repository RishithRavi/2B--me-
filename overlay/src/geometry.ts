// Pure helpers for the overlay shell (unit-tested with node:test).

export type Mode = "pill" | "panel" | "prompt" | "lock";
export const MODES: readonly Mode[] = ["pill", "panel", "prompt", "lock"];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// must match the pill in web/src/components/overlay/overlay-view.tsx (304×68 at right/top 8px)
export const PILL = { width: 320, height: 84, margin: 12 } as const;
export const PANEL = { width: 420, height: 540 } as const;

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
