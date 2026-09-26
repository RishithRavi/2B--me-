// Bridge to the Electron shell (overlay/src/preload.ts exposes window.twobmeOverlay). In a plain browser the
// bridge is absent and the overlay page just renders its current mode inside the viewport (handy for dev).

export type OverlayMode =
  | "pill" //    small always-on-top trust pill (top-right)
  | "details" // "My behavior": the pill expanded into a panel (top-right, still floating over other apps)
  | "panel" //   centered card: sign in
  | "prompt" //  full screen, dimmed, dismissible: a different person may be at the keyboard → voice check
  | "lock"; //   full screen, opaque, not dismissible: device locked by a failed voice check

export interface OverlayBridge {
  setMode(mode: OverlayMode): void;
  version: string;
  hardLock: boolean;
}

declare global {
  interface Window {
    twobmeOverlay?: OverlayBridge;
  }
}

export function overlayBridge(): OverlayBridge | null {
  if (typeof window === "undefined") return null;
  return window.twobmeOverlay ?? null;
}

export function inElectron(): boolean {
  return overlayBridge() !== null;
}
