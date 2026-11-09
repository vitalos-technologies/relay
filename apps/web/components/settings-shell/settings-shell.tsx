'use client';
// Settings shell: persistent grouped left navigation (≥1024px) or a left drawer + breadcrumb (smaller screens).
// Every sub-setting is a real URL; search only lists entries this user can see.
import * as D from '@radix-ui/react-dialog';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, PanelLeft, Search, X } from 'lucide-react';
import { useSession } from '@/lib/client/session';
import { cn } from '@/components/ui';
import { useFlags } from '@/lib/client/flags';
import { itemHref, visibleSettings, type SettingsGroup, type SettingsItem } from './registry';
import { HelpLink } from '@/components/help/help-link';

function useActive(groups: SettingsGroup[]) {
  const pathname = usePathname();
  for (const g of groups) for (const i of g.items) {
    const h = itemHref(i);
    if (pathname === h || (i.href && pathname.startsWith(`${h}/`))) return { group: g, item: i };
  }
  return null;
}

export function SettingsShell({ children }: { children: ReactNode }) {
  const { can, canV2 } = useSession();
  const flags = useFlags();
  const groups = useMemo(() => visibleSettings({ can, canV2, flag: flags.enabled }), [can, canV2, flags]);
  const active = useActive(groups);
  const [drawer, setDrawer] = useState(false);
  const pathname = usePathname();
  useEffect(() => setDrawer(false), [pathname]);

  return (
    <div className="lg:grid lg:grid-cols-[232px_minmax(0,1fr)] lg:gap-10">
      <aside aria-label="Settings" className="hidden lg:block">
        <div className="sticky top-[88px] max-h-[calc(100dvh-112px)] overflow-y-auto pb-6 pr-1">
          <p className="mb-3 text-[13px] font-semibold text-muted">Settings</p>
          <SettingsNav groups={groups} active={active?.item ?? null} />
        </div>
      </aside>

      <div className="min-w-0">
        {/* Mobile / tablet: the breadcrumb opens the grouped settings drawer */}
        <button
          type="button"
          onClick={() => setDrawer(true)}
          aria-haspopup="dialog"
          className="touch-target -ml-2 mb-1 inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-muted hover:bg-raised hover:text-fg lg:hidden"
        >
          <PanelLeft aria-hidden className="size-4" />Settings
          {active ? <><ChevronRight aria-hidden className="size-3.5" /><span>{active.group.label}</span></> : null}
          <span className="sr-only"> — open settings menu</span>
        </button>
        <nav aria-label="Breadcrumb" className="mb-1 hidden text-xs text-subtle lg:block">
          <ol className="flex items-center gap-1">
            <li>Settings</li>
            {active ? <><li aria-hidden><ChevronRight className="size-3" /></li><li>{active.group.label}</li></> : null}
          </ol>
        </nav>
        {active && !active.item.ownHeader ? (
          <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 md:mb-8">
            <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em] md:text-[28px]">{active.item.label}</h1>
            {active.item.help ? <HelpLink href={active.item.help} label={`About ${active.item.label}`} /> : null}
          </div>
        ) : null}
        {children}
      </div>

      <D.Root open={drawer} onOpenChange={setDrawer}>
        <D.Portal>
          <D.Overlay className="anim-fade fixed inset-0 z-50 bg-[var(--overlay)] lg:hidden" />
          <D.Content aria-describedby={undefined} className="fixed inset-y-0 left-0 z-50 flex w-[300px] max-w-[88vw] flex-col border-r border-border bg-surface shadow-[var(--shadow)] lg:hidden">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <D.Title className="text-[15px] font-semibold">Settings</D.Title>
              <D.Close asChild>
                <button type="button" aria-label="Close" className="touch-target inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg">
                  <X aria-hidden className="size-4" />
                </button>
              </D.Close>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <SettingsNav groups={groups} active={active?.item ?? null} />
            </div>
          </D.Content>
        </D.Portal>
      </D.Root>
    </div>
  );
}

function SettingsNav({ groups, active }: { groups: SettingsGroup[]; active: SettingsItem | null }) {
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const results = term
    ? groups.flatMap((g) => g.items.filter((i) => `${i.label} ${g.label} ${i.keywords ?? ''}`.toLowerCase().includes(term)).map((i) => ({ g, i })))
    : null;
  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" />
        <label htmlFor="settings-search" className="sr-only">Search settings</label>
        <input
          id="settings-search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          className="h-9 w-full rounded-lg border border-border bg-sunken pl-8 pr-3 text-[13px] placeholder:text-subtle hover:border-border-strong"
        />
      </div>
      {results ? (
        results.length ? (
          <ul className="flex flex-col gap-0.5" aria-label="Search results">
            {results.map(({ g, i }) => <NavItem key={`${g.id}/${i.slug}`} item={i} active={active === i} hint={g.label} />)}
          </ul>
        ) : <p className="px-2 text-[13px] text-muted">No matches</p>
      ) : (
        groups.map((g) => (
          <div key={g.id} role="group" aria-labelledby={`sg-${g.id}`}>
            <p id={`sg-${g.id}`} className="mb-1 px-2 text-[11px] font-medium uppercase tracking-[0.06em] text-subtle">{g.label}</p>
            <ul className="flex flex-col gap-0.5">
              {g.items.map((i) => <NavItem key={i.slug} item={i} active={active === i} />)}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}

function NavItem({ item, active, hint }: { item: SettingsItem; active: boolean; hint?: string }) {
  const Icon = item.icon;
  return (
    <li>
      <Link
        href={itemHref(item)}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'group flex h-9 items-center gap-2.5 rounded-lg px-2 text-[13px] font-medium transition-colors duration-150',
          active ? 'bg-raised text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg',
        )}
      >
        <Icon aria-hidden strokeWidth={1.75} className={cn('size-4 shrink-0', active ? 'text-accent-text' : 'text-subtle group-hover:text-muted')} />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {hint ? <span className="truncate text-[11px] text-subtle">{hint}</span> : null}
      </Link>
    </li>
  );
}
