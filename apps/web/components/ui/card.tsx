import type { ReactNode } from 'react';
import { cn } from './cn';

export function Card({ children, className, as: As = 'section', ...rest }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'article' | 'li' } & Record<string, unknown>) {
  return <As className={cn('rounded-xl border border-border bg-surface', className)} {...rest}>{children}</As>;
}

export function CardHeader({ title, description, actions, className, id }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string; id?: string }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4', className)}>
      <div className="min-w-0">
        <h2 id={id} className="text-[14px] font-semibold">{title}</h2>
        {description ? <p className="mt-0.5 text-[13px] text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1.5 text-xs font-medium uppercase tracking-[0.08em] text-subtle">{eyebrow}</div> : null}
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] sm:text-[26px]">{title}</h1>
        {description ? <p className="mt-1 max-w-[70ch] text-[13px] text-muted sm:text-sm">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Definition list for key/value facts. */
export function Facts({ items, className }: { items: Array<[ReactNode, ReactNode]>; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-2 text-[13px]', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
