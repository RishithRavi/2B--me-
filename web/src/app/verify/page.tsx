// STUB (A0) — owner: Codex 2
"use client";

import { AudioLines } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { EmptyState, PageHeader } from "@/components/site/empty-state";

function VerifyBody() {
  const params = useSearchParams();
  const c = params.get("c");
  return (
    <div className="panel">
      <EmptyState icon={AudioLines} title="Voice check coming soon">
        {c ? (
          <>
            Challenge <code className="font-mono text-foreground">{c}</code> is waiting for the voice step-up flow.
          </>
        ) : (
          "Open this page from a challenge link (/verify?c=…)."
        )}
      </EmptyState>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <PageHeader eyebrow="Step-up" title="Voice check">
        Listen to the prompt, then read the phrase back. We check the words, the speaker and whether the voice is synthetic.
      </PageHeader>
      <Suspense fallback={<div className="panel h-48 animate-pulse" />}>
        <VerifyBody />
      </Suspense>
    </div>
  );
}
