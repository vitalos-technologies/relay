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

export function IconTile({ children, className }: { children: ReactNode; className?: string }) {
  return <span aria-hidden className={cn('inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-v5-primary-soft text-v5-primary-text [&>svg]:size-5', className)}>{children}</span>;
}
