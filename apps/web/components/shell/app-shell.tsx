'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, useState, type ReactNode } from 'react';
import {
  Activity, CalendarDays, CheckCheck, Ellipsis, FileClock, House, Images, Plug, Settings, SquarePen, Wrench, type LucideIcon,
} from 'lucide-react';
import type { Action } from '@social-lite/core';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { useHrefWithBrand } from '@/lib/client/hooks';
import type { ApprovalSummary } from '@/lib/client/types';
import { cn, Menu, MenuContent, MenuLinkItem, MenuTrigger } from '@/components/ui';
import { WorkspaceSwitcher } from './workspace-switcher';
import { BrandFilter } from './brand-filter';
import { EmergencyPause } from './emergency-pause';
import { NotificationBell } from './notification-bell';
import { UserMenu } from './user-menu';
import { ShellBanners } from './shell-banners';
import { Logo } from './logo';

interface NavItem { href: string; label: string; icon: LucideIcon; perm?: Action; badge?: 'approvals'; mobile?: boolean }

const NAV: NavItem[] = [
  { href: '/', label: 'Home', icon: House, mobile: true },
  { href: '/planner', label: 'Planner', icon: CalendarDays, mobile: true },
  { href: '/compose', label: 'Compose', icon: SquarePen, perm: 'drafts.edit', mobile: true },
  { href: '/approvals', label: 'Approvals', icon: CheckCheck, badge: 'approvals', mobile: true },
  { href: '/library', label: 'Library', icon: Images },
  { href: '/history', label: 'History', icon: FileClock, perm: 'history.read' },
  { href: '/accounts', label: 'Accounts', icon: Plug },
  { href: '/settings', label: 'Settings', icon: Settings },
];
const ADMIN_NAV: NavItem[] = [
  { href: '/setup', label: 'Setup', icon: Wrench, perm: 'setup.manage' },
  { href: '/operations', label: 'Operations', icon: Activity, perm: 'diagnostics.read' },
];

function isActive(pathname: string, href: string) {
  if (href === '/') return pathname === '/';
  if (href === '/compose') return pathname === '/compose' || pathname.startsWith('/posts/');
  return pathname === href || pathname.startsWith(`${href}/`);
}

function useApprovalsCount(enabled: boolean) {
  const { data } = useApi<{ items: ApprovalSummary[]; next_cursor?: string | null }>(enabled ? '/api/approvals?status=pending' : null, { poll: 60_000 });
  if (!data) return null;
  return { count: data.items.length, more: !!data.next_cursor };
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <ShellInner>{children}</ShellInner>
    </Suspense>
  );
}

function ShellInner({ children }: { children: ReactNode }) {
  const { can } = useSession();
  const pathname = usePathname();
  const withBrand = useHrefWithBrand();
  const approvals = useApprovalsCount(true);
  const visible = NAV.filter((n) => !n.perm || can(n.perm));
  const admin = ADMIN_NAV.filter((n) => !n.perm || can(n.perm));
  const mobilePrimary = visible.filter((n) => n.mobile);
  const mobileMore = [...visible.filter((n) => !n.mobile), ...admin];

  const badgeFor = (n: NavItem) =>
    n.badge === 'approvals' && approvals && approvals.count > 0 ? `${approvals.count}${approvals.more ? '+' : ''}` : null;

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[224px_minmax(0,1fr)]">
      <a href="#main" className="sr-only-focusable fixed left-3 top-3 z-[80] rounded-lg bg-accent px-3 py-2 text-on-accent">Skip to content</a>

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-surface md:flex" aria-label="Primary">
        <div className="flex h-16 items-center px-4">
          <Logo />
        </div>
        <div className="flex flex-col gap-2 px-3 pb-4">
          <WorkspaceSwitcher />
          <BrandFilter />
        </div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-2">
          <ul className="flex flex-col gap-0.5">
            {visible.map((n) => (
              <NavLink key={n.href} item={n} href={withBrand(n.href)} active={isActive(pathname, n.href)} badge={badgeFor(n)} />
            ))}
          </ul>
          {admin.length ? (
            <>
              <p className="mb-1 mt-6 px-2 text-[11px] font-medium text-subtle">Admin</p>
              <ul className="flex flex-col gap-0.5">
                {admin.map((n) => (
                  <NavLink key={n.href} item={n} href={n.href} active={isActive(pathname, n.href)} badge={null} />
                ))}
              </ul>
            </>
          ) : null}
        </nav>
        <div className="flex flex-col gap-2 p-3">
          <EmergencyPause />
          <div className="flex items-center gap-1">
            <UserMenu />
            <NotificationBell />
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface/95 px-3 backdrop-blur md:hidden">
        <Logo compact />
        <div className="min-w-0 flex-1"><BrandFilter compact /></div>
        <NotificationBell />
        <UserMenu compact />
      </header>

      <div className="flex min-w-0 flex-col">
        <ShellBanners />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1200px] flex-1 px-4 pb-28 pt-6 focus:outline-none sm:px-6 md:px-8 md:pb-16 md:pt-8">
          {children}
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <ul className="grid grid-cols-5">
          {mobilePrimary.slice(0, 4).map((n) => {
            const active = isActive(pathname, n.href);
            const b = badgeFor(n);
            return (
              <li key={n.href}>
                <Link
                  href={withBrand(n.href)}
                  aria-current={active ? 'page' : undefined}
                  className={cn('relative flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium', active ? 'text-fg' : 'text-muted')}
                >
                  <span className={cn('relative flex h-7 w-12 items-center justify-center rounded-full', active && 'bg-raised text-fg')}>
                    <n.icon aria-hidden className="size-[18px]" />
                    {b ? <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-[var(--text)] px-1 text-center text-[10px] leading-4 text-bg">{b}<span className="sr-only"> pending</span></span> : null}
                  </span>
                  {n.label}
                </Link>
              </li>
            );
          })}
          <li>
            <MobileMore items={mobileMore} pathname={pathname} withBrand={withBrand} />
          </li>
        </ul>
      </nav>
    </div>
  );
}

function MobileMore({ items, pathname, withBrand }: { items: NavItem[]; pathname: string; withBrand: (h: string) => string }) {
  const [open, setOpen] = useState(false);
  const active = items.some((n) => isActive(pathname, n.href));
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>
        <button type="button" className={cn('flex h-16 w-full flex-col items-center justify-center gap-1 text-[11px] font-medium', active ? 'text-fg' : 'text-muted')}>
          <span className={cn('flex h-7 w-12 items-center justify-center rounded-full', active && 'bg-raised text-fg')}>
            <Ellipsis aria-hidden className="size-[18px]" />
          </span>
          More
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="mb-2 w-56">
        {items.map((n) => (
          <MenuLinkItem key={n.href} href={withBrand(n.href)} icon={<n.icon aria-hidden />} active={isActive(pathname, n.href)}>
            {n.label}
          </MenuLinkItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function NavLink({ item, href, active, badge }: { item: NavItem; href: string; active: boolean; badge: string | null }) {
  const Icon = item.icon;
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'group relative flex h-9 items-center gap-3 rounded-lg px-2 text-[13px] font-medium transition-colors',
          active ? 'bg-raised text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg',
        )}
      >
        <Icon aria-hidden className={cn('size-4', active ? 'text-fg' : 'text-subtle group-hover:text-muted')} />
        <span className="flex-1">{item.label}</span>
        {badge ? (
          <span className="rounded-full bg-raised px-1.5 text-[11px] font-semibold leading-5 text-fg tabular">
            {badge}
            <span className="sr-only"> pending</span>
          </span>
        ) : null}
      </Link>
    </li>
  );
}
