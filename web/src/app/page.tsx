"use client";

import type { ReactNode } from "react";

import { Hero } from "@/components/landing/hero";
import { HowItWorks, PrivacyPromise, RiskExamples, SponsorStrip } from "@/components/landing/sections";
import { SignatureTree } from "@/components/landing/signature-tree";
import { Wordmark } from "@/components/site/logo";
import { useLive } from "@/lib/live";
import { useMockMode } from "@/lib/mode";
import { useMe } from "@/lib/session";

function Section({ id, eyebrow, title, children, lead }: { id: string; eyebrow: string; title: ReactNode; lead?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-16 sm:px-6">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{title}</h2>
      {lead && <p className="mt-3 max-w-3xl text-muted-foreground">{lead}</p>}
      <div className="mt-8">{children}</div>
    </section>
  );
}

export default function HomePage() {
  const me = useMe();
  const envMock = useMockMode();
  const signedIn = me.status === "ok" && !me.mock;
  // Signed-in visitors see their own live stream; everyone else sees the clearly-labelled simulation.
  const simulated = envMock || !signedIn;
  const { state } = useLive({ mock: simulated, enabled: me.status !== "loading" });

  return (
    <div className="flex flex-col">
      <Hero state={state} simulated={simulated} signedIn={signedIn} />

      <Section id="how" eyebrow="How it works" title="Identity isn't a moment. It's a rhythm." lead="Three steps, running all the time in the background.">
        <HowItWorks />
        <div className="mt-4">
          <RiskExamples />
        </div>
      </Section>

      <Section
        id="signature"
        eyebrow="The behavioral signature"
        title="Every branch of the signature maps to measured features"
        lead={
          <>
            Each leaf below comes straight from our feature spec. A dot lights up when a recent evidence block carried that signal
            {simulated ? " (simulated stream)" : ""}. Hover a leaf to see its features.
          </>
        }
      >
        <SignatureTree state={state} live={state.trust !== null} />
      </Section>

      <Section id="privacy" eyebrow="Privacy is part of the product" title="Timing, never content">
        <PrivacyPromise />
      </Section>

      <Section id="sponsors" eyebrow="Built with" title="Every partner is used for real">
        <SponsorStrip />
      </Section>

      <footer className="mx-auto flex w-full max-w-6xl flex-col items-start justify-between gap-3 border-t px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:px-6">
        <Wordmark />
        <span>HackGT 13 · continuous behavioral authentication · 2bme.tech</span>
      </footer>
    </div>
  );
}
