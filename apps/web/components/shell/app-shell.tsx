'use client';
// V3 app shell: primary nav grouped per D28 (240px expanded ≥1280, 72px rail 768–1279, role-based bottom bar + More on phones per D29), a slim top bar with
// workspace/brand scope + notifications + account, and the shell banners (offline, paused, demo once per workspace).
// Settings pages render their own grouped left nav inside the content area (components/settings-shell).
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { Ellipsis } from 'lucide-react';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { useHrefWithBrand } from '@/lib/client/hooks';
import { pruneNamespace } from '@/lib/client/draft-recovery';
import { FlagsProvider } from '@/lib/client/flags';
import type { ApprovalSummary } from '@/lib/client/types';
import { cn, Menu, MenuContent, MenuGroup, MenuLabel, MenuLinkItem, MenuSeparator, MenuTrigger, Tooltip } from '@/components/ui';
import { WorkspaceSwitcher } from './workspace-switcher';
import { BrandFilter } from './brand-filter';
import { EmergencyPause } from './emergency-pause';
import { NotificationBell } from './notification-bell';
import { UserMenu } from './user-menu';
import { ShellBanners } from './shell-banners';
import { Logo } from './logo';
import { CommandMenu, SearchTrigger } from './command-menu';
import { isActive, navFor, type NavGroup, type NavItem } from './nav-config';

const BOTTOM_COLS: Record<number, string> = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-5' };

function useApprovalsCount(enabled: boolean) {
  const { data } = useApi<{ items: ApprovalSummary[]; next_cursor?: string | null }>(enabled ? '/api/approvals?status=pending' : null, { poll: 60_000 });
  if (!data) return null;
  return { count: data.items.length, more: !!data.next_cursor };
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <FlagsProvider>
        <ShellInner>{children}</ShellInner>
      </FlagsProvider>
    </Suspense>
  );
}

function ShellInner({ children }: { children: ReactNode }) {
  const { can, canV2, session } = useSession();
  // Drop expired browser copies of drafts (and all of them when the workspace turned local recovery off).
  const recoveryPolicy = session.draft_recovery;
  useEffect(() => { pruneNamespace(recoveryPolicy); }, [recoveryPolicy]);
  const pathname = usePathname();
  const withBrand = useHrefWithBrand();
  const approvals = useApprovalsCount(true);
  const { groups, admin, bottom: mobilePrimary, more: mobileMore } = navFor({ can, canV2 });

  const badgeFor = (n: NavItem) =>
    n.badge === 'approvals' && approvals && approvals.count > 0 ? `${approvals.count}${approvals.more ? '+' : ''}` : null;

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[var(--rail-w)_minmax(0,1fr)] xl:grid-cols-[var(--nav-w)_minmax(0,1fr)]">
      <a href="#main" className="sr-only-focusable fixed left-3 top-3 z-[80] rounded-lg bg-accent px-3 py-2 text-on-accent">Skip to content</a>

      {/* Desktop sidebar: rail (md–lg), expanded (xl+) */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-surface md:flex" aria-label="Primary">
        <div className="flex h-14 items-center justify-center px-3 xl:justify-start xl:px-5">
          <span className="xl:hidden"><Logo compact /></span>
          <span className="hidden xl:inline-flex"><Logo /></span>
        </div>
        <div className="px-3 pb-3">
          <div className="xl:hidden"><WorkspaceSwitcher compact /></div>
          <div className="hidden xl:block"><WorkspaceSwitcher /></div>
        </div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 pb-3">
          {groups.map((g, i) => (
            <div key={g.id} role="group" aria-labelledby={`nav-${g.id}`} className={cn(i > 0 && 'mt-2 border-t border-border pt-2 xl:mt-3 xl:border-t-0 xl:pt-0')}>
              <p id={`nav-${g.id}`} className="mb-1 px-2.5 text-[11px] font-medium uppercase tracking-[0.06em] text-subtle max-xl:sr-only">{g.label}</p>
              <ul className="flex flex-col gap-0.5">
                {g.items.map((n) => (
                  <NavLink key={n.href} item={n} href={withBrand(n.href)} active={isActive(pathname, n)} badge={badgeFor(n)} />
                ))}
              </ul>
            </div>
          ))}
          {admin.length ? (
            <div className="mt-4 border-t border-border pt-4" role="group" aria-labelledby="nav-admin">
              <p id="nav-admin" className="mb-1 px-2.5 text-[11px] font-medium uppercase tracking-[0.06em] text-subtle max-xl:sr-only">Admin</p>
              <ul className="flex flex-col gap-0.5">
                {admin.map((n) => (
                  <NavLink key={n.href} item={n} href={n.href} active={isActive(pathname, n)} badge={null} />
                ))}
              </ul>
            </div>
          ) : null}
        </nav>
        <div className="border-t border-border p-3">
          <div className="flex justify-center xl:hidden"><EmergencyPause variant="rail" /></div>
          <div className="hidden xl:block"><EmergencyPause /></div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        {/* Top bar: scope (all widths), notifications, account */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] px-3 backdrop-blur sm:px-4 md:px-6">
          <span className="md:hidden"><Logo compact /></span>
          <div className="min-w-0 max-w-[260px] flex-1 max-[430px]:flex-none md:flex-none md:basis-[240px]"><BrandFilter compact /></div>
          <span className="flex-1" />
          <SearchTrigger />
          <NotificationBell />
          <UserMenu compact />
        </header>
        <ShellBanners />
        <CommandMenu />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1320px] flex-1 px-4 pb-28 pt-6 focus:outline-none sm:px-6 md:px-8 md:pb-16 md:pt-8">
          {children}
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <ul className={cn('grid', BOTTOM_COLS[mobilePrimary.length + 1])}>
          {mobilePrimary.map((n) => {
            const active = isActive(pathname, n);
            const b = badgeFor(n);
            return (
              <li key={n.href}>
                <Link
                  href={withBrand(n.href)}
                  aria-current={active ? 'page' : undefined}
                  className={cn('relative flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium', active ? 'text-fg' : 'text-muted')}
                >
                  <span className={cn('relative flex h-7 w-12 items-center justify-center rounded-full', active && 'bg-accent-soft text-accent-text')}>
                    <n.icon aria-hidden className="size-[18px]" />
                    {b ? <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-on-accent">{b}<span className="sr-only"> pending</span></span> : null}
                  </span>
                  {n.label}
                </Link>
              </li>
            );
          })}
          <li>
            <MobileMore groups={mobileMore} admin={admin} pathname={pathname} withBrand={withBrand} />
          </li>
        </ul>
      </nav>
    </div>
  );
}

function MobileMore({ groups, admin, pathname, withBrand }: { groups: NavGroup[]; admin: NavItem[]; pathname: string; withBrand: (h: string) => string }) {
  const [open, setOpen] = useState(false);
  const active = [...groups.flatMap((g) => g.items), ...admin].some((n) => isActive(pathname, n));
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>
        <button type="button" className={cn('flex h-16 w-full flex-col items-center justify-center gap-1 text-[11px] font-medium', active ? 'text-fg' : 'text-muted')}>
          <span className={cn('flex h-7 w-12 items-center justify-center rounded-full', active && 'bg-accent-soft text-accent-text')}>
            <Ellipsis aria-hidden className="size-[18px]" />
          </span>
          More
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="mb-2 max-h-[var(--radix-dropdown-menu-content-available-height)] w-60 overflow-y-auto">
        {groups.map((g, i) => (
          <MenuGroup key={g.id}>
            {i > 0 ? <MenuSeparator /> : null}
            <MenuLabel>{g.label}</MenuLabel>
            {g.items.map((n) => (
              <MenuLinkItem key={n.href} href={withBrand(n.href)} icon={<n.icon aria-hidden />} active={isActive(pathname, n)}>
                {n.label}
              </MenuLinkItem>
            ))}
          </MenuGroup>
        ))}
        {admin.length ? (
          <>
            <MenuSeparator />
            <MenuLabel>Admin</MenuLabel>
            {admin.map((n) => (
              <MenuLinkItem key={n.href} href={n.href} icon={<n.icon aria-hidden />} active={isActive(pathname, n)}>{n.label}</MenuLinkItem>
            ))}
          </>
        ) : null}
        <div className="border-t border-border p-1 pt-2"><EmergencyPause /></div>
      </MenuContent>
    </Menu>
  );
}

function NavLink({ item, href, active, badge }: { item: NavItem; href: string; active: boolean; badge: string | null }) {
  const Icon = item.icon;
  const link = (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      aria-label={badge ? `${item.label}, ${badge} pending` : undefined}
      className={cn(
        'group relative flex h-10 items-center justify-center gap-3 rounded-lg text-[14px] font-medium transition-colors duration-150 xl:h-9 xl:justify-start xl:px-2.5',
        active ? 'bg-raised text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg',
      )}
    >
      {active ? <span aria-hidden className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-accent max-xl:-left-3" /> : null}
      <Icon aria-hidden strokeWidth={1.75} className={cn('size-[18px] shrink-0', active ? 'text-accent-text' : 'text-subtle group-hover:text-muted')} />
      <span className="hidden flex-1 truncate xl:block">{item.label}</span>
      {badge ? (
        <>
          <span aria-hidden className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent xl:hidden" />
          <span aria-hidden className="hidden rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-5 text-on-accent tabular xl:inline">{badge}</span>
        </>
      ) : null}
    </Link>
  );
  return (
    <li>
      <div className="xl:hidden"><Tooltip content={item.label} side="right">{link}</Tooltip></div>
      <div className="hidden xl:block">{link}</div>
    </li>
  );
}
