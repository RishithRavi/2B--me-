"use client";

import { FlaskConical, LogIn, LogOut, Moon, Sun, UserRound } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, errorMessage } from "@/lib/api";
import { useMockMode } from "@/lib/mode";
import { clearMe, useMe } from "@/lib/session";
import { setTheme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

import { Wordmark } from "./logo";

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/enroll", label: "Enroll" },
  { href: "/shop", label: "Shop" },
  { href: "/history", label: "History" },
  { href: "/lab", label: "Lab" },
] as const;

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const { status, me } = useMe();
  const mock = useMockMode();
  const theme = useTheme();

  async function logout() {
    try {
      await api.logout();
    } catch (e) {
      toast.error(`Logout failed: ${errorMessage(e)}`);
      return;
    }
    clearMe();
    router.push("/login");
  }

  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md supports-backdrop-filter:bg-background/65">
      <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="shrink-0 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50" aria-label="2bME home">
          <Wordmark />
        </Link>

        <nav className="scrollbar-thin -mx-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1 sm:ml-4">
          {LINKS.map((l) => {
            const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={cn(
                  "relative rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
                  active && "text-foreground",
                )}
              >
                {l.label}
                {active && <span className="absolute inset-x-2.5 -bottom-[11px] h-px bg-foreground" />}
              </Link>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-1.5">
          {mock && (
            <Badge variant="outline" className="hidden gap-1 border-trust-watch/40 font-mono text-[10px] tracking-wider text-trust-watch uppercase sm:inline-flex">
              <FlaskConical /> Mock data
            </Badge>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
          {status === "ok" && me ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  <UserRound />
                  <span className="hidden max-w-[10rem] truncate sm:inline">{me.handle}</span>
                  {me.role === "admin" && <span className="hidden font-mono text-[10px] text-muted-foreground uppercase sm:inline">obs</span>}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                <DropdownMenuLabel className="space-y-0.5">
                  <div className="text-sm font-medium">{me.email}</div>
                  <div className="text-xs font-normal text-muted-foreground">
                    {me.role === "admin" ? "Observer (admin)" : "User"}
                    {me.device ? ` · ${me.device.label}` : ""}
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/dashboard?stage=1">Stage view (projector)</Link>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void logout()} disabled={mock}>
                  <LogOut /> Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : status === "loading" ? (
            <div className="h-7 w-20 animate-pulse rounded-md bg-muted" />
          ) : (
            <Button asChild size="sm" variant="outline">
              <Link href="/login">
                <LogIn /> Log in
              </Link>
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
