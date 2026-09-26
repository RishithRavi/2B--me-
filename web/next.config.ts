import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// Production: a static export (web/out) served by Caddy, with /api and /ws same-origin on 2bme.tech.
// Dev (`pnpm dev`): proxy /api to the FastAPI backend on :8000 and point the live socket straight at it.
// Rules: no dynamic route segments (use ?c=…), no API routes, no middleware, no server actions.
export default function config(phase: string): NextConfig {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    const backend = process.env.BACKEND_ORIGIN ?? "http://localhost:8000";
    return {
      agentRules: false, // don't generate AGENTS.md / CLAUDE.md in web/
      devIndicators: false, // the dev badge would sit on top of the /overlay pill
      env: {
        NEXT_PUBLIC_WS_ORIGIN: process.env.NEXT_PUBLIC_WS_ORIGIN ?? backend.replace(/^http/, "ws"),
      },
      async rewrites() {
        return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
      },
    };
  }
  return {
    output: "export",
    images: { unoptimized: true },
    trailingSlash: false,
  };
}
