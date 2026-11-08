'use client';
// V3 design system: layout primitives shared by every redesigned screen (docs/V3_DESIGN_SYSTEM.md).
import * as D from '@radix-ui/react-dialog';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, ChevronsUpDown, Film, ImageOff, Images, X } from 'lucide-react';
import type { Provider } from '@social-lite/core';
import { cn } from './cn';
import { PlatformIcon } from './platform-icon';

// ------------------------------------------------------------------ filter bar
/** One row of filters above the content it controls; wraps on narrow screens. Filters live in the URL. */
export function FilterBar({ children, end, className, label = 'Filters' }: { children: ReactNode; end?: ReactNode; className?: string; label?: string }) {
  return (
    <div role="group" aria-label={label} className={cn('mb-6 flex flex-wrap items-center gap-2', className)}>
      {children}
      {end ? <div className="ml-auto flex flex-wrap items-center gap-2">{end}</div> : null}
    </div>
  );
}

/** Compact labelled select for filter bars (label is visually hidden; the first option says what it filters). */
export function FilterSelect({ id, label, value, onChange, children, className, disabled, title }: {
  id: string; label: string; value: string; onChange: (v: string) => void; children: ReactNode; className?: string; disabled?: boolean; title?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={id} className="sr-only">{label}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        title={title}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'touch-target h-9 w-full max-w-full appearance-none truncate rounded-lg border border-border bg-surface bg-no-repeat pl-3 pr-8 text-[13px] text-fg transition-colors hover:border-border-strong disabled:opacity-50',
          value ? 'border-border-strong font-medium' : 'text-muted',
        )}
        style={{ backgroundImage: 'linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%)', backgroundPosition: 'calc(100% - 15px) 52%, calc(100% - 10px) 52%', backgroundSize: '5px 5px, 5px 5px' }}
      >
        {children}
      </select>
    </div>
  );
}

// ------------------------------------------------------------------ section header (inside pages)
export function SectionHeader({ title, actions, id, className, count }: { title: ReactNode; actions?: ReactNode; id?: string; className?: string; count?: number | null }) {
  return (
    <div className={cn('mb-3 flex min-h-8 flex-wrap items-center justify-between gap-2', className)}>
      <h2 id={id} className="flex items-center gap-2 text-[15px] font-semibold">
        {title}
        {count !== undefined && count !== null ? <span className="rounded-full bg-raised px-2 text-xs font-medium leading-5 text-muted tabular">{count}</span> : null}
      </h2>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

// ------------------------------------------------------------------ thumbnail
export function Thumb({ src, alt, kind, className, provider }: { src: string | null | undefined; alt?: string | null; kind?: 'image' | 'video' | 'album' | 'text' | null; className?: string; provider?: Provider }) {
  return (
    <span className={cn('relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-sunken text-subtle', className)}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt ?? ''} loading="lazy" decoding="async" className="size-full object-cover" />
      ) : provider ? <PlatformIcon provider={provider} size="sm" decorative /> : <ImageOff aria-hidden className="size-4" />}
      {kind === 'video' ? <span aria-hidden className="absolute bottom-1 right-1 rounded bg-black/70 p-0.5 text-white"><Film className="size-3" /></span> : null}
      {kind === 'album' ? <span aria-hidden className="absolute bottom-1 right-1 rounded bg-black/70 p-0.5 text-white"><Images className="size-3" /></span> : null}
    </span>
  );
}

// ------------------------------------------------------------------ content card (thumbnail row)
/** A piece of content in a list: thumbnail, title, meta line, trailing status/value. Whole row is the link when href/onClick. */
export function ContentCard({
  thumb, title, meta, trailing, href, onClick, className, dense, label,
}: {
  thumb?: ReactNode; title: ReactNode; meta?: ReactNode; trailing?: ReactNode; href?: string; onClick?: () => void; className?: string; dense?: boolean; label?: string;
}) {
  const inner = (
    <>
      {thumb}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium">{title}</span>
        {meta ? <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted">{meta}</span> : null}
      </span>
      {trailing ? <span className="flex shrink-0 items-center gap-2">{trailing}</span> : null}
    </>
  );
  const cls = cn('group flex w-full min-w-0 items-center gap-3 rounded-xl text-left', dense ? 'px-2 py-1.5' : 'px-2 py-2', (href || onClick) && 'hover:bg-raised/60', className);
  if (href) return <Link href={href} className={cls} aria-label={label}>{inner}</Link>;
  if (onClick) return <button type="button" onClick={onClick} className={cls} aria-label={label}>{inner}</button>;
  return <div className={cls}>{inner}</div>;
}

// ------------------------------------------------------------------ data table: sortable header
export function SortTh({ children, active, dir, onSort, className, align = 'left' }: {
  children: ReactNode; active: boolean; dir: 'asc' | 'desc'; onSort: () => void; className?: string; align?: 'left' | 'right';
}) {
  const Icon = !active ? ChevronsUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th scope="col" aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={cn('whitespace-nowrap px-3 py-2.5 font-medium', align === 'right' && 'text-right', className)}>
      <button type="button" onClick={onSort} className={cn('inline-flex items-center gap-1 rounded hover:text-fg', active && 'text-fg', align === 'right' && 'flex-row-reverse')}>
        {children}<Icon aria-hidden className="size-3.5" />
      </button>
    </th>
  );
}

// ------------------------------------------------------------------ detail drawer
/** Right-side contextual drawer (full-screen sheet on phones). Escape / overlay closes; focus is trapped. */
export function DetailDrawer({
  open, onOpenChange, title, meta, children, footer, wide,
}: { open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; meta?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="anim-fade fixed inset-0 z-50 bg-[var(--overlay)]" />
        <D.Content
          aria-describedby={undefined}
          className={cn('anim-slide fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-surface shadow-[var(--shadow)]', wide ? 'max-w-[640px]' : 'max-w-[480px]')}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <D.Title className="truncate text-[16px] font-semibold">{title}</D.Title>
              {meta ? <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">{meta}</div> : null}
            </div>
            <D.Close asChild>
              <button type="button" aria-label="Close" className="touch-target -mr-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg">
                <X aria-hidden className="size-4" />
              </button>
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3.5">{footer}</div> : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function DrawerSection({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('border-b border-border py-4 first:pt-0 last:border-b-0', className)}>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-[0.04em] text-subtle">{title}</h3>
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ feature / integration tiles
/** Orange outlined icon on a dark rounded tile (brand rule for integration/feature tiles). */
export function FeatureTile({ children, className, size = 'md' }: { children: ReactNode; className?: string; size?: 'sm' | 'md' }) {
  return (
    <span aria-hidden className={cn('inline-flex shrink-0 items-center justify-center rounded-[10px] bg-tile text-tile-fg', size === 'sm' ? 'size-8 [&>svg]:size-4' : 'size-10 [&>svg]:size-5', className)}>
      {children}
    </span>
  );
}

/** Integration card: icon/tile, name, state badge, one-line detail, actions. */
export function IntegrationCard({
  icon, name, badge, detail, actions, children, className, testId, as: As = 'div',
}: {
  icon: ReactNode; name: ReactNode; badge?: ReactNode; detail?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; testId?: string; as?: 'div' | 'li';
}) {
  return (
    <As data-testid={testId} className={cn('flex min-w-0 flex-col rounded-[var(--radius-card)] border border-border bg-surface p-4', className)}>
      <div className="flex items-start gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate text-[14px] font-medium">{name}</span>
            {badge}
          </div>
          {detail ? <div className="mt-1 text-xs text-muted">{detail}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {children}
    </As>
  );
}

/** A link out of the current context (e.g. a Settings entry that lives on its own page). */
export function OutLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={cn('inline-flex items-center gap-1 text-[13px] font-medium text-accent-text hover:underline', className)}>
      {children}<ArrowUpRight aria-hidden className="size-3.5" />
    </Link>
  );
}
