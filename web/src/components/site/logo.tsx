import { cn } from "@/lib/utils";

/** The mark: an open trust arc with a live dot. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-6", className)}>
      <defs>
        <linearGradient id="twobme-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--brand)" />
          <stop offset="100%" stopColor="var(--brand-2)" />
        </linearGradient>
      </defs>
      <path
        d="M6.3 22.5A11 11 0 1 1 25.7 22.5"
        fill="none"
        stroke="url(#twobme-mark)"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <path d="M9.5 17.5h3l2-4 3 8 2-4h3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
      <circle cx="25.7" cy="22.5" r="2.2" fill="var(--brand)" />
    </svg>
  );
}

/** "2bME" wordmark — the "2b" carries the brand gradient. */
export function Wordmark({ className, withMark = true }: { className?: string; withMark?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      {withMark && <LogoMark />}
      <span className="text-[1.05em] leading-none">
        <span className="text-brand-gradient font-mono font-bold italic">2b</span>
        <span>ME</span>
      </span>
    </span>
  );
}
