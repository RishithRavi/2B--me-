# 2bME overlay (Electron)

The on-laptop face of 2bME. A single transparent, frameless, always-on-top window on A's Mac that loads
`<origin>/overlay` from the site (same React code as the dashboard) and resizes itself per mode:

| Mode | When | Window |
|---|---|---|
| **pill** | normal use | 320×84, top-right, never steals focus; trust %, level, sparkline; red **Verify** when a voice check is waiting. Click it → **details** |
| **details** | "My behavior" (the pill expanded) | 400×700 (clamped to the work area), top-right, doesn't pull the app forward: trust + 10-min sparkline, per-modality ΔL bars, why-chips, identity model and scorer, the literal last payload that left the laptop (collapsed), recent events, link to the full dashboard. × collapses it |
| **prompt** | a proactive (or step-up) challenge is armed — someone else may be at the keyboard | full display, dimmed, voice check inside; **Not now** snoozes to the red pill (behavior alone never blocks; high-risk actions keep stepping up) |
| **lock** | the device was locked by a failed voice check (BLOCK_SPOOF / BLOCK_IMPOSTOR / failed TOTP) | full display, opaque, refocuses on blur, can't be closed; the owner signs in again and unlocks with a fresh phrase. **Fails closed:** the lock (and its reason) is remembered in the overlay's own storage, so offline, loading, signed out or before the first live snapshot it still shows the lock screen; only the owner's live snapshot saying "unlocked" releases it |
| **panel** | signing in | centered card |

The page decides the mode from `/ws/live` (see `web/src/components/overlay/`); the shell only sizes the
window (`overlay/src/geometry.ts`) and enforces the lock. A prompt that closes with a BLOCK_* goes straight to
the lock screen (the page holds full screen until the outcome is known, so the window never flashes back to
the pill). Voice checks show a **Simulated voice result** badge when the server runs stub voice. It captures no input — behavior capture is the
macOS agent's job — and it talks only to the 2bME origin (other links open in the default browser;
microphone permission is granted to the 2bME origin only).

## Run (A's laptop, from Terminal.app)
```bash
cd overlay && corepack pnpm i          # first time (downloads Electron)
corepack pnpm start                    # → https://2bme.tech/overlay
TWOBME_URL=http://localhost:3000 corepack pnpm start   # against a local `pnpm dev`
corepack pnpm dev                      # local + ?dev=1 (stub-decision select in the voice check)
```
Flags: `--url=<origin>`, `--dev`, `--devtools` (only together with `--dev`), `--hard-lock` (or
`TWOBME_HARD_LOCK=1`: macOS kiosk presentation while locked — hides the Dock/menu bar and disables app
switching).

**Hardening:** the application menu is removed entirely (`Menu.setApplicationMenu(null)`: no ⌘H hide, ⌘W close,
⌘Q quit or ⌥⌘I inspect accelerators), and DevTools can't be opened at all without `--dev`
(`webPreferences.devTools`). Not GUI-verified on the demo Mac yet: try ⌘H, ⌘Tab, ⌥⌘I, a full-screen app and a
second display while locked (the lock covers the display under the cursor only).
Sign in once inside the pill (cookie persists in the `persist:twobme-overlay` partition).
macOS asks for microphone access on first start (for the voice check).

**Operator escape hatch:** ⌃⌥⌘⇧Q quits the overlay even while locked (demo safety). `/demo/reset` also
unlocks. In dev only, ⌃⌥⌘O toggles DevTools.

If launched from a VS Code terminal, `ELECTRON_RUN_AS_NODE=1` is inherited; the npm scripts clear it.

## Relation to the agent
While the overlay is connected, the server sees a browser bound to the device on `/ws/live`, so the agent's
`challenge` handling stays a notification (it only runs `open verify_url` when no bound browser/overlay is
connected). `/verify` and `/shop` in Chrome keep working as before.

## Tests
`corepack pnpm run test` (geometry / args / origin guard / shell policy, node:test) — also run by
`scripts/gate.sh`. In a worktree where `node_modules` is a symlink, run `./node_modules/.bin/tsc -p . && node
--test dist/*.test.js` instead. Mode logic is unit-tested in `web/src/components/overlay/overlay-state.test.ts`
and the page itself (mock stream, fake timers, jsdom) in `overlay-view.test.ts`.
