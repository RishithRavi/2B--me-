import type { Metadata } from "next";

import { OverlayChrome } from "@/components/overlay/overlay-chrome";
import { OverlayView } from "@/components/overlay/overlay-view";

export const metadata: Metadata = { title: "Overlay" };

/** Loaded by the Electron overlay (overlay/). Transparent page; the shell sizes the window per mode. */
export default function OverlayPage() {
  return (
    <OverlayChrome>
      <OverlayView />
    </OverlayChrome>
  );
}
