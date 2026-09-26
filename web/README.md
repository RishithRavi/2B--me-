# 2bME web

Next.js (App Router, static export) + Tailwind v4 + shadcn/ui + Recharts + framer-motion. Caddy serves it from `web/out`;
the API is same-origin at `/api` and the live stream is at `/ws/live`.

Use pnpm through corepack (Node 22+):

```sh
corepack pnpm install
```

## Dev

```sh
# backend (FastAPI) on :8000, then:
corepack pnpm dev            # http://localhost:3000; /api/* is proxied to :8000
```

In dev, the live socket connects straight to `ws://localhost:8000/ws/live`. The session cookie is shared across ports
on localhost. Override the backend with `BACKEND_ORIGIN=http://host:port` or the socket with
`NEXT_PUBLIC_WS_ORIGIN=ws://host:port`.

## Mock mode (no backend)

```sh
NEXT_PUBLIC_MOCK=1 corepack pnpm dev
```

Or add `?mock=1` to any URL. It sticks for the browser tab; `?mock=0` turns it off. Mock mode never opens a socket.
Instead, it generates a believable synthetic `/ws/live` stream in the browser:

1. A works at about 97%.
2. A takeover marker arrives at about 40 s.
3. Trust falls about 0.07 per tick, with red why-chips.
4. After 2 ticks below 40%, a proactive challenge fires.
5. A $2,000 purchase is stepped up.
6. A cloned voice is blocked, and the device locks.
7. A voice unlock follows, and the loop starts again.

The dashboard controls drive the simulation, and pressing any control stops the autoplay. `/history` and `/lab` show
sample data (it mirrors `contracts/fixtures/reports`). Every mock surface is labelled "Mock data" or "sample data".

When a visitor isn't signed in, the landing hero uses the same simulated stream and says so.

## Build, test, typecheck

```sh
corepack pnpm build          # → out/ (index.html, login.html, dashboard.html, history.html, lab.html, enroll.html, shop.html, verify.html)
corepack pnpm test           # vitest: live reducer, TTD stopwatch, ui helpers
corepack pnpm typecheck      # tsc --noEmit
```

## Layout

- `src/lib/contracts.ts`: **generated** from Python (`uv run python scripts/core_gen_ts.py`). Don't edit it.
- `src/lib/api.ts`: typed REST client (`api.*`), one function per endpoint in `contracts/api.md`. It throws `ApiError{status, detail}`.
- `src/lib/live.ts`: the `/ws/live` client, in three parts:
  - `applyLive(state, event)`: the pure reducer;
  - `LiveStore`: one shared socket per page, with 0.5 s → 10 s backoff;
  - `useLive()`: the React hook.
- `src/lib/live-mock.ts`: the synthetic stream. `src/lib/sample-data.ts` holds the mock-mode REST samples.
- `src/lib/ttd.ts`: the time-to-detection stopwatch and takeover intervals.
- `src/lib/resource.ts`: `useResource()`, client-side fetching with a localStorage fallback. When the API fails, the
  last good copy is shown with a "cached" badge.
- `src/lib/ui.ts`: formatters (`fmtPct`, `fmtAgo`, …) and `levelColor`, `levelLabel`, `modalityColor`, `modalityIcon`.
- `src/app/globals.css`: design tokens (`--trust-{normal,watch,suspicious,locked,learning}`, `--mod-{keyboard,…}`).
  The categorical modality palette was validated for colorblind separation in both themes.
- `src/components/{site,dashboard,landing,history,lab,charts}`: the building blocks for each page.
  `src/components/voice/` belongs to the voice workstream.

Pages: `/` (landing), `/login`, `/dashboard` (`?stage=1` is the observer/projector layout), `/history`, `/lab`.
`/enroll`, `/shop` and `/verify` are stubs that other workstreams own.

Static-export rules: no dynamic route segments (use query params such as `/verify?c=<id>`), no API routes,
no middleware and no server actions. All data fetching happens on the client.
