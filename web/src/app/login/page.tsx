"use client";

import { ArrowRight, Loader2, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { SIMULATED_TAKEOVER } from "@/components/landing/links";
import { Wordmark } from "@/components/site/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, api } from "@/lib/api";
import { clearMockMode } from "@/lib/mode";
import { refreshMe } from "@/lib/session";

/** Where to go after signing in: a same-site path from ?next= (never "//host" or a full URL), else the dashboard. */
function nextPath(search: string): string {
  const next = new URLSearchParams(search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/dashboard";
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(email.trim(), password);
      clearMockMode(); // a visitor who watched the simulation first must now see their live data
      await refreshMe();
      router.push(nextPath(window.location.search));
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.offline ? "Can't reach the 2bME API right now." : err.status === 401 ? "Wrong email or password." : err.detail);
      } else {
        setError("Login failed.");
      }
      setBusy(false);
    }
  }

  return (
    <div className="relative flex flex-1 items-center justify-center px-4 py-16">
      <div className="bg-console-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]" />
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Wordmark className="text-2xl" />
          <p className="text-sm text-balance text-muted-foreground">
            Login proves who you <em>were</em>. 2bME keeps checking who you <em>are</em>.
          </p>
        </div>
        <form onSubmit={onSubmit} className="panel space-y-5 p-6 shadow-2xl shadow-black/20">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              placeholder="a@2bme.tech"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="h-9 w-full" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />}
            Sign in
          </Button>
          <div className="flex items-start gap-2 rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-trust-normal" />
            <span>
              Signing in never raises device trust. Only your behavior (or a voice check) does.
            </span>
          </div>
        </form>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          No account?{" "}
          {/* plain <a>: a full page load, so the nav and footer re-read mock mode (landing/links.ts) */}
          <a href={SIMULATED_TAKEOVER} className="underline underline-offset-4 hover:text-foreground">
            Watch a simulated takeover
          </a>
        </p>
      </div>
    </div>
  );
}
