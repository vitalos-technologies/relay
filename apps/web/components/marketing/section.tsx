// Marketing layout primitives (server): page container, section heading with one gradient keyword, icon tile.
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/components/ui-v5/cn';

export function Container({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-8', className)} {...props} />;
}

/** Heading text with `*one keyword*` rendered in the accent gradient (mockup: one gradient word per heading). */
export function Accent({ text }: { text: string }) {
  const parts = text.split('*');
  return <>{parts.map((p, i) => (i % 2 ? <span key={i} className="mkt-gradient-text">{p}</span> : <span key={i}>{p}</span>))}</>;
}

export function SectionHeading({ id, eyebrow, title, lead, align = 'center', className }: { id?: string; eyebrow?: string; title: string; lead?: ReactNode; align?: 'center' | 'left'; className?: string }) {
  return (
    <div className={cn('flex max-w-2xl flex-col gap-3', align === 'center' ? 'mx-auto items-center text-center' : 'items-start text-left', className)}>
      {eyebrow ? <p className="text-[13px] font-semibold uppercase tracking-[0.08em] text-v5-primary-text">{eyebrow}</p> : null}
      <h2 id={id} tabIndex={-1} className="outline-none text-balance text-[30px] font-extrabold leading-[1.1] tracking-[-0.03em] text-v5-fg sm:text-[40px]"><Accent text={title} /></h2>
      {lead ? <p className="text-pretty text-[17px] text-v5-muted">{lead}</p> : null}
    </div>
  );
}

/** Small eyebrow: a short accent pill dash + uppercase label (Integrations and Pricing, user request 2026-11-11). */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('flex items-center gap-2 text-[12px] font-semibold uppercase leading-none tracking-[0.08em] text-v5-primary-text', className)}>
      <span aria-hidden className="h-1.5 w-3 rounded-full bg-[linear-gradient(90deg,var(--mkt-accent-from),var(--mkt-accent-to))]" />
      {children}
    </p>
  );
}

/** Two-line heading: line 1 ink, line 2 muted grey (large text, 3.4:1 on white). Focusable for in-page navigation. */
export function TwoToneHeading({ id, lines: [first, second], className }: { id: string; lines: [string, string]; className?: string }) {
  return (
    <h2 id={id} tabIndex={-1} className={cn('outline-none text-balance text-[34px] font-semibold leading-[1.06] tracking-[-0.04em] text-v5-fg sm:text-[44px] lg:text-[48px]', className)}>
      <span className="block">{first}</span>{' '}
      <span className="block text-[var(--mkt-heading-muted)]">{second}</span>
    </h2>
  );
}

export function IconTile({ children, className }: { children: ReactNode; className?: string }) {
  return <span aria-hidden className={cn('inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-v5-primary-soft text-v5-primary-text [&>svg]:size-5', className)}>{children}</span>;
}
