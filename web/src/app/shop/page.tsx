// STUB (A0) — owner: Codex 2
"use client";

import { ShoppingBag } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/site/empty-state";

export default function ShopPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <PageHeader eyebrow="Demo scenario · Visa-style 3DS" title="Checkout">
        A $2,000 purchase is authorized by live behavioral confidence: Y (frictionless), C (step-up) or N (declined).
      </PageHeader>
      <div className="panel">
        <EmptyState icon={ShoppingBag} title="Shop coming soon">
          This page is owned by the voice workstream. Visa is a demo scenario, not an affiliation.
        </EmptyState>
      </div>
    </div>
  );
}
