"use client";

import { Building2, FlaskConical } from "lucide-react";
import type { ReactNode } from "react";

import { Hero, PrimaryCta } from "@/components/landing/hero";
import { EVIDENCE, ORG_CONSOLE_DEMO } from "@/components/landing/links";
import { Problem } from "@/components/landing/problem";
import { SafeLoop } from "@/components/landing/safe-loop";
import { HowItWorks, PrivacyPromise, RiskExamples, SponsorStrip } from "@/components/landing/sections";
import { SignatureTree } from "@/components/landing/signature-tree";
import { ProductSurfaces } from "@/components/landing/surfaces";
import { Wordmark } from "@/components/site/logo";
import { Button } from "@/components/ui/button";
import { useLive } from "@/lib/live";
import { useMockMode } from "@/lib/mode";
import { useMe } from "@/lib/session";

function Section({ id, eyebrow, title, children, lead }: { id: string; eyebrow: string; title: ReactNode; lead?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-14 sm:px-6 sm:py-16">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{title}</h2>
      {lead && <p className="mt-3 max-w-3xl text-pretty text-muted-foreground">{lead}</p>}
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
      <Hero state={state} simulated={simulated} signedIn={!simulated} />

      <Section
        id="problem"
        eyebrow="The problem"
        title="A login is a moment. An attack is a session."
        lead="Stolen sessions, remote-access scams and an unlocked laptop all look like the rightful owner to anything that only checked who signed in."
      >
        <Problem />
      </Section>

      <Section
        id="how"
        eyebrow="How it works"
        title="We don't ask who you are. We ask whether you're still you."
        lead="Four steps, running quietly in the background for one enrolled person."
      >
        <HowItWorks />
      </Section>

      <Section
        id="learning"
        eyebrow="How it keeps learning"
        title="It learns only from you being you"
        lead="Behavior drifts, so the baseline has to grow. The rule for what the model may learn from is strict, and it is designed so that an attacker at the keyboard can't teach it their habits."
      >
        <SafeLoop />
      </Section>

      <Section
        id="surfaces"
        eyebrow="Two products, one signal"
        title="An overlay for you. A console for your security team."
        lead="Individuals get a guard on their own Mac. Small companies get organization-wide visibility: alerts the moment someone stops looking like themselves, insider-threat flags, and a trail to trace a breach back."
      >
        <ProductSurfaces />
      </Section>

      <Section
        id="step-up"
        eyebrow="Risk-based step-up"
        title="The same $2,000 order. Two very different sessions."
        lead="Credentials alone never buy high trust. The riskier the action, the more confidence it needs; below the bar, 2bME asks for an independent check instead of guessing."
      >
        <RiskExamples />
      </Section>

      <Section
        id="signature"
        eyebrow="The behavioral signature"
        title="Every branch maps to measured features"
        lead={
          <>
            Each leaf comes straight from our feature spec, and the count beside it is how many features back it. A dot lights up when a recent evidence
            block carried that signal{simulated ? " (simulated stream)" : ""}. Hover or tap a leaf to see its features.
          </>
        }
      >
        <SignatureTree state={state} live={state.trust !== null} />
      </Section>

      <Section id="privacy" eyebrow="Privacy is part of the product" title="Timing, never content">
        <PrivacyPromise />
      </Section>

      <Section id="sponsors" eyebrow="Built with" title="What each partner actually does here">
        <SponsorStrip />
      </Section>

      <section className="border-t bg-card/40">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-14 sm:px-6 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">See it catch a takeover.</h2>
            <p className="mt-2 max-w-xl text-muted-foreground">
              The stage view shows live trust, the takeover stopwatch and every step-up as it happens. The org console shows the same signal across a
              synthetic company.
            </p>
            <a href={EVIDENCE} className="mt-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              <FlaskConical className="size-4" /> Or read the verification evidence
            </a>
          </div>
          <div className="flex flex-wrap gap-3">
            <PrimaryCta signedIn={!simulated} />
            <Button asChild size="lg" variant="outline" className="h-10 px-4">
              <a href={ORG_CONSOLE_DEMO}>
                <Building2 /> Open the org console demo
              </a>
            </Button>
          </div>
        </div>
      </section>

      <footer className="mx-auto flex w-full max-w-6xl flex-col items-start justify-between gap-3 border-t px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:px-6">
        <Wordmark />
        <span>HackGT 13 · continuous behavioral authentication · 2bme.tech</span>
      </footer>
    </div>
  );
}
