// STUB (A0) — owner: Codex 1
"use client";

import { UserPlus } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/site/empty-state";

export default function EnrollPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <PageHeader eyebrow="Enrollment" title="Teach 2bME how you work">
        Structured top-up for keyboard, pointer, scroll and workflow evidence, plus voice enrollment.
      </PageHeader>
      <div className="panel">
        <EmptyState icon={UserPlus} title="Enrollment flow coming soon">
          This page is owned by the signals workstream. Meanwhile, use the dashboard&apos;s enroll/monitor toggle and
          Train button.
        </EmptyState>
      </div>
    </div>
  );
}
