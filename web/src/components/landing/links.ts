// Landing CTAs that cross between live and mock mode. Mock mode is sticky per tab (lib/mode.ts: ?mock=1 sets it,
// ?mock=0 clears it), so every live link says mock=0 explicitly: a judge who opened the org console demo first must
// still land on A's real device, not the simulated stream. They are plain <a> (full page loads), not next/link, so
// the persistent nav and footer re-read the mode along with the page.
export const LIVE_DASHBOARD = "/dashboard?stage=1&mock=0";
export const SIMULATED_TAKEOVER = "/dashboard?stage=1&mock=1";
export const ORG_CONSOLE_DEMO = "/admin?mock=1";
export const EVIDENCE = "/lab?mock=0";
