"use client";

import { Loader2, LogIn } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, api } from "@/lib/api";
import { refreshMe } from "@/lib/session";

/** Compact sign-in used inside the overlay (a web login never changes device trust). */
export function OverlaySignIn({ onDone, hint }: { onDone: () => void; hint?: string }) {
  const [email, setEmail] = useState("a@2bme.tech");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.login(email, password);
      await refreshMe();
      setPassword("");
      onDone();
    } catch (x) {
      setErr(x instanceof ApiError ? (x.offline ? "Can't reach 2bME." : x.detail || `HTTP ${x.status}`) : String(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      <div className="space-y-1.5">
        <Label htmlFor="ov-email">Email</Label>
        <Input id="ov-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ov-pw">Password</Label>
        <Input id="ov-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      </div>
      {err && <p className="text-sm text-trust-suspicious">{err}</p>}
      <Button type="submit" className="w-full" disabled={busy || !password}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />} Sign in
      </Button>
    </form>
  );
}
