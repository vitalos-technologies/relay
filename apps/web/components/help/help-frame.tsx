// Help Centre page frame (HC, server component): left section sidebar (≥ lg), a "Browse help" disclosure on smaller
// screens, and breadcrumbs. Only sections/articles this reader may open are passed in.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { sectionIcon } from './help-icons';

export interface FrameSection { id: string; title: string; icon: string; articles: Array<{ slug: string; title: string; href: string }> }

export function Breadcrumbs({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-3 min-w-0">
      <ol className="flex flex-wrap items-center gap-1 text-[13px] text-muted">
        {items.map((it, i) => (
          <li key={`${it.label}-${i}`} className="flex min-w-0 items-center gap-1">
            {i > 0 ? <ChevronRight aria-hidden className="size-3.5 shrink-0 text-subtle" /> : null}
            {it.href ? <Link href={it.href} className="truncate rounded hover:text-fg hover:underline">{it.label}</Link>
              : <span aria-current="page" className="truncate font-medium text-fg">{it.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function SectionNav({ sections, section, slug }: { sections: FrameSection[]; section?: string; slug?: string }) {
  return (
    <ul className="flex flex-col gap-0.5">
      <li>
        <Link href="/help" aria-current={!section ? 'page' : undefined}
          className={cn('flex min-h-9 items-center gap-2.5 rounded-lg px-2 text-[13px] font-medium', !section ? 'bg-raised text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg')}>
          <span aria-hidden className="size-4" />Help home
        </Link>
      </li>
      {sections.map((s) => {
        const Icon = sectionIcon(s.icon);
        const current = s.id === section;
        return (
          <li key={s.id}>
            <Link href={`/help/${s.id}`} aria-current={current && !slug ? 'page' : undefined}
              className={cn('flex min-h-9 items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] font-medium leading-snug',
                current ? 'text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg', current && !slug ? 'bg-raised' : '')}>
              <Icon aria-hidden strokeWidth={1.75} className={cn('size-4 shrink-0', current ? 'text-accent-text' : 'text-subtle')} />{s.title}
            </Link>
            {current && s.articles.length ? (
              <ul className="mb-1 ml-[18px] mt-0.5 flex flex-col border-l border-border pl-2.5">
                {s.articles.map((a) => (
                  <li key={a.slug}>
                    <Link href={a.href} aria-current={a.slug === slug ? 'page' : undefined}
                      className={cn('block rounded-md px-2 py-1.5 text-[13px] leading-snug', a.slug === slug ? 'bg-raised font-medium text-fg' : 'text-muted hover:text-fg')}>
                      {a.title}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Two-column help layout: section sidebar + content. */
export function HelpFrame({ sections, section, slug, children }: { sections: FrameSection[]; section?: string; slug?: string; children: ReactNode }) {
  const current = sections.find((s) => s.id === section);
  return (
    <div className="lg:grid lg:grid-cols-[232px_minmax(0,1fr)] lg:gap-10">
      <aside aria-label="Help sections" className="hidden lg:block">
        <div className="sticky top-[88px] max-h-[calc(100dvh-112px)] overflow-y-auto pb-6 pr-1">
          <SectionNav sections={sections} section={section} slug={slug} />
        </div>
      </aside>
      <div className="min-w-0">
        <details className="group mb-4 rounded-xl border border-border bg-surface lg:hidden">
          <summary className="touch-target flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-2.5 text-[14px] font-medium [&::-webkit-details-marker]:hidden">
            <span className="truncate">{current ? `${current.title}` : 'Browse help'}</span>
            <ChevronRight aria-hidden className="size-4 shrink-0 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none" />
          </summary>
          <nav aria-label="Help sections" className="border-t border-border px-2 py-2">
            <SectionNav sections={sections} section={section} slug={slug} />
          </nav>
        </details>
        {children}
      </div>
    </div>
  );
}
