import Link from 'next/link';

/** Wordmark: a lime signal dot + "Social Lite". */
export function Logo({ compact }: { compact?: boolean }) {
  return (
    <Link href="/" className="inline-flex items-center gap-2 rounded-md" aria-label="Social Lite home">
      <span aria-hidden className="relative inline-flex size-7 items-center justify-center rounded-lg border border-border bg-raised">
        <span className="size-2.5 rounded-full bg-accent shadow-[0_0_12px_var(--accent)]" />
      </span>
      {compact ? null : <span className="text-[15px] font-semibold tracking-[-0.01em]">Social Lite</span>}
    </Link>
  );
}
