"use client";

import { FlaskConical, LogIn, LogOut, Menu, Moon, Sun, UserRound } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api, errorMessage } from "@/lib/api";
import { useMockMode } from "@/lib/mode";
import { clearMe, useMe } from "@/lib/session";
import { setTheme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

import { Wordmark } from "./logo";

// "Admin" (the org control panel, §2.4) is visible to everyone: admins get the live org, everyone else lands on
// its gate, whose primary action is the synthetic org demo.
const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/enroll", label: "Enroll" },
  { href: "/shop", label: "Shop" },
  { href: "/history", label: "History" },
  { href: "/lab", label: "Lab" },
  { href: "/admin", label: "Admin" },
] as const;

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const { status, me } = useMe();
  const mock = useMockMode();
  const theme = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  // A plain <a> on purpose: the full page load with ?mock=0 clears the tab's sticky mock mode (lib/mode.ts).
  const exitHref = `${pathname}?mock=0`;
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

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

  if (pathname === "/overlay") return null; // the Electron overlay has no site chrome

  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md supports-backdrop-filter:bg-background/65">
      <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="shrink-0 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50" aria-label="2bME home">
          <Wordmark />
        </Link>

        <nav aria-label="Main" className="scrollbar-thin -mx-1 hidden min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1 py-1 md:ml-4 md:flex">
          {LINKS.map((l) => {
            const active = isActive(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
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
        <div className="flex-1 md:hidden" />

        <div className="flex shrink-0 items-center gap-1.5">
          {mock && (
            <>
              {/* Below md: a compact badge that opens the menu, where Exit demo lives. */}
              <button
                type="button"
                onClick={() => setMenuOpen(true)}
                aria-label="Mock data (open the menu to exit the demo)"
                title="Mock data"
                className="inline-flex h-6 items-center rounded-4xl border border-trust-watch/40 bg-trust-watch/8 px-1.5 text-trust-watch outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:hidden"
              >
                <FlaskConical className="size-3.5" />
              </button>
              <span className="hidden h-6 items-center overflow-hidden rounded-4xl border border-trust-watch/40 text-trust-watch md:inline-flex">
                <span className="inline-flex items-center gap-1 px-2 font-mono text-[10px] tracking-wider uppercase" title="Mock data">
                  <FlaskConical className="size-3" />
                  <span className="hidden lg:inline">Mock data</span>
                </span>
                <a
                  href={exitHref}
                  className="inline-flex h-full items-center border-l border-trust-watch/40 px-2 text-[11px] font-medium outline-none hover:bg-trust-watch/12 focus-visible:bg-trust-watch/12"
                >
                  Exit demo
                </a>
              </span>
            </>
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
                <Button variant="outline" size="sm" className="gap-1.5" aria-label="Account menu">
                  <UserRound />
                  <span className={cn("hidden max-w-[10rem] truncate", mock ? "lg:inline" : "md:inline")}>{mock ? "Demo observer" : me.handle}</span>
                  {me.role === "admin" && !mock && <span className="hidden font-mono text-[10px] text-muted-foreground uppercase md:inline">obs</span>}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                <DropdownMenuLabel className="space-y-0.5">
                  {mock ? (
                    <>
                      <div className="text-sm font-medium">Simulated demo session</div>
                      <div className="text-xs font-normal text-muted-foreground">Demo observer · synthetic data, no account</div>
                    </>
                  ) : (
                    <>
                      <div className="text-sm font-medium">{me.email}</div>
                      <div className="text-xs font-normal text-muted-foreground">
                        {me.role === "admin" ? "Observer (admin)" : "User"}
                        {me.device ? ` · ${me.device.label}` : ""}
                      </div>
                    </>
                  )}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/dashboard?stage=1">Stage view (projector)</Link>
                </DropdownMenuItem>
                {mock ? (
                  <DropdownMenuItem asChild>
                    {/* Full page load: ?mock=0 ends the demo before the real login. */}
                    <a href="/login?mock=0">
                      <LogIn /> Log in (exits demo)
                    </a>
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => void logout()}>
                    <LogOut /> Log out
                  </DropdownMenuItem>
                )}
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
          <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
            <Menu />
          </Button>
        </div>
      </div>

      {/* Below md: the page links (and the demo switch) in a sheet, so none hides behind the strip's overflow. */}
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="right" className="w-72 gap-0 p-0">
          <SheetHeader className="border-b px-4 pt-4 pb-3">
            <SheetTitle>Menu</SheetTitle>
            <SheetDescription className="sr-only">Site pages</SheetDescription>
          </SheetHeader>
          <nav aria-label="Main" className="flex flex-col gap-0.5 p-2">
            {LINKS.map((l) => {
              const active = isActive(l.href);
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setMenuOpen(false)}
                  className={cn(
                    "flex items-center justify-between rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
                    active && "bg-muted font-medium text-foreground",
                  )}
                >
                  {l.label}
                  {active && <span className="size-1.5 rounded-full bg-foreground" aria-hidden />}
                </Link>
              );
            })}
          </nav>
          {mock && (
            <div className="mx-2 mt-2 space-y-2 rounded-lg border border-trust-watch/40 bg-trust-watch/8 p-3">
              <div className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-wider text-trust-watch uppercase">
                <FlaskConical className="size-3" /> Mock data
              </div>
              <p className="text-xs text-muted-foreground">This tab shows synthetic data simulated in your browser.</p>
              <Button asChild size="sm" variant="outline" className="w-full">
                <a href={exitHref}>Exit demo</a>
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </header>
  );
}
