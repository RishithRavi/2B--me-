"use client";

import { LogIn, ShieldOff } from "lucide-react";
import Link from "next/link";

import { AdminView } from "@/components/admin/admin-view";
import { EmptyState } from "@/components/site/empty-state";
import { Button } from "@/components/ui/button";
import { useMockMode } from "@/lib/mode";
import { useMe } from "@/lib/session";

export default function AdminPage() {
  const { status, me } = useMe();
  const mock = useMockMode();

  if (status === "loading") {
    return <div className="mx-auto h-96 w-full max-w-[1440px] animate-pulse px-6 py-6" />;
  }

  if (!mock && (status !== "ok" || me?.role !== "admin")) {
    return (
      <div className="mx-auto w-full max-w-lg px-4 py-20">
        <div className="panel">
          <EmptyState
            icon={ShieldOff}
            title="Admins only"
            action={
              <div className="flex gap-2">
                <Button asChild size="sm">
                  <Link href="/login">
                    <LogIn /> Log in as admin
                  </Link>
                </Button>
              </div>
            }
          >
            The org control panel is scoped to the admin role. It shows a synthetic, anonymized roster — no real
            employee data — so it never needs a live session either.
          </EmptyState>
        </div>
      </div>
    );
  }

  return <AdminView />;
}
