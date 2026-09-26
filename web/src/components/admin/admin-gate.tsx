"use client";

// What anonymous visitors, non-admin users and an unreachable API see at /admin: a way in to the synthetic org
// demo instead of a dead end, over a blurred, inert preview of the panel itself.
import { BellRing, FlaskConical, LogIn, Route, ShieldCheck, Users } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { MeOut } from "@/lib/contracts";
import type { MeStatus } from "@/lib/session";

import { AdminView } from "./admin-view";

const POINTS = [
  { icon: Users, title: "20 anonymized employees", text: "continuous trust for every device, grouped by team" },
  { icon: BellRing, title: "Alerted the moment someone deviates", text: "takeover, insider drift, remote sessions" },
  { icon: Route, title: "Breach trace-back", text: "every trust change, alert, challenge and admin action" },
] as const;

export function AdminGate({ status, me }: { status: MeStatus; me: MeOut | null }) {
  const note =
    status === "offline"
      ? "The API is unreachable right now. The demo runs entirely in your browser."
      : status === "ok" && me
        ? `Signed in as ${me.email}. The live org view needs the admin role.`
        : "The live org view needs an admin sign-in.";

  return (
    <div className="relative isolate min-h-[calc(100dvh-8rem)] overflow-hidden">
      <div
        aria-hidden
        inert
        className="pointer-events-none absolute inset-0 -z-10 opacity-45 blur-[3px] select-none [mask-image:linear-gradient(to_bottom,black_35%,transparent_95%)]"
      >
        <AdminView source="demo" preview />
      </div>
      <div className="absolute inset-0 -z-10 bg-background/40" aria-hidden />

      <div className="mx-auto flex w-full max-w-xl flex-col px-4 pt-14 pb-16 sm:pt-20">
        <div className="panel space-y-5 p-6 shadow-2xl shadow-black/30 sm:p-8">
          <div className="space-y-2">
            <p className="eyebrow">2bME for organizations</p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Org control panel</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              The cyber admin&apos;s view of a whole organization. Login proves who someone <em>was</em>; this panel keeps checking who each employee{" "}
              <em>is</em>, flags takeovers and insider drift in real time, and keeps the audit trail that traces a breach back.
            </p>
          </div>

          <ul className="space-y-2.5">
            {POINTS.map((p) => (
              <li key={p.title} className="flex items-start gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-brand ring-1 ring-foreground/10">
                  <p.icon className="size-4" />
                </span>
                <span className="text-sm">
                  <span className="font-medium">{p.title}</span>
                  <span className="block text-[13px] text-muted-foreground">{p.text}</span>
                </span>
              </li>
            ))}
          </ul>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button asChild size="lg" className="h-10 text-sm sm:flex-1">
              {/* A full page load on purpose: ?mock=1 turns on the tab's demo mode (lib/mode.ts). */}
              <a href="/admin?mock=1">
                <FlaskConical /> View the org demo (synthetic data)
              </a>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-10 text-sm">
              <Link href="/login">
                <LogIn /> Admin sign-in
              </Link>
            </Button>
          </div>

          <div className="flex items-start gap-2 border-t pt-4 text-[12px] text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-trust-normal" />
            <p>
              {note} The demo org is synthetic and anonymized: pseudonymous &ldquo;Employee NN&rdquo; sessions simulated from a fixed seed, never a
              real person or device.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
