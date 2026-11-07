import type { ReactNode } from 'react';
import { cn } from './cn';

export function Card({ children, className, as: As = 'section', ...rest }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'article' | 'li' } & Record<string, unknown>) {
  return <As className={cn('rounded-xl border border-border bg-surface', className)} {...rest}>{children}</As>;
}

/** Card title row. No subtitles: keep headings short and put detail behind an info tooltip if it is truly needed. */
export function CardHeader({ title, actions, className, id }: { title: ReactNode; actions?: ReactNode; className?: string; id?: string }) {
  return (
    <div className={cn('flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 pt-4', className)}>
      <h2 id={id} className="min-w-0 text-[14px] font-semibold">{title}</h2>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Page title (one word where possible) + optional compact meta chip + actions. */
export function PageHeader({ title, meta, actions, eyebrow }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1 truncate text-xs text-subtle">{eyebrow}</div> : null}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="min-w-0 break-words text-[22px] font-semibold tracking-[-0.01em] sm:text-[24px]">{title}</h1>
          {meta ? <MetaChip>{meta}</MetaChip> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Small neutral pill for secondary metadata (zone, scope, counts). Truncates. */
export function MetaChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex h-6 max-w-full items-center gap-1.5 truncate rounded-full bg-raised px-2 text-xs text-muted', className)}>
      {children}
    </span>
  );
}

/** Definition list for key/value facts. */
export function Facts({ items, className }: { items: Array<[ReactNode, ReactNode]>; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(96px,auto)_1fr] gap-x-4 gap-y-2 text-[13px]', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
