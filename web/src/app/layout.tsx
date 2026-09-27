import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";

import { Nav } from "@/components/site/nav";
import { PresenceMount } from "@/components/site/presence-mount";
import { StatusFooter } from "@/components/site/status-footer";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { THEME_INIT_SCRIPT } from "@/lib/theme-script";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "2bME — continuous behavioral authentication", template: "%s · 2bME" },
  description:
    "Login proves who you were. 2bME keeps checking who you are: a continuous trust score from privacy-safe typing, pointer and scroll rhythm, with a voice or one-time-code step-up when it stops matching.",
  metadataBase: new URL("https://2bme.tech"),
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0f1117" },
    { media: "(prefers-color-scheme: light)", color: "#f8f9fb" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`dark ${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="flex min-h-dvh flex-col">
        <TooltipProvider delayDuration={150}>
          <Nav />
          <main className="flex flex-1 flex-col pb-10">{children}</main>
          <StatusFooter />
          <PresenceMount />
          <Toaster position="top-right" richColors closeButton />
        </TooltipProvider>
      </body>
    </html>
  );
}
