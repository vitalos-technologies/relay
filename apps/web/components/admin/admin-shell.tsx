'use client';
// Admin shell (V3.1 Admin §15–16): left sidebar with collapsible groups (all Settings sub-pages included), scope switch
// Workspace ↔ Platform, nav filter, breadcrumbs, Cmd/Ctrl+K jump palette, live-sync indicator. Under 1024 px the
// sidebar becomes a focus-trapped drawer (Radix Dialog) with the same expandable groups. Server enforces everything.
import * as D from '@radix-ui/react-dialog';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Menu as MenuIcon, Search, ServerCog, Building2, X } from 'lucide-react';
import { useSession } from '@/lib/client/session';
import { FlagsProvider, useFlags } from '@/lib/client/flags';
import { RelayMark } from '@/components/brand/relay-mark';
import { WorkspaceSwitcher } from '@/components/shell/workspace-switcher';
import { UserMenu } from '@/components/shell/user-menu';
import { cn, EmptyState, Input, LinkButton } from '@/components/ui';
import { AdminSyncProvider, SyncIndicator } from './sync';
import { PLATFORM_NAV, WORKSPACE_NAV, activeItem, isActiveItem, visibleNav, type AdminNavGroup, type AdminNavItem, type AdminPerms } from './nav';

export function AdminShell({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <FlagsProvider>
        <AdminInner>{children}</AdminInner>
      </FlagsProvider>
    </Suspense>
  );
}

function useAdminPerms(): AdminPerms {
  const { can, canV2, session } = useSession();
  const flags = useFlags();
  return { can, canV2, flag: flags.enabled, platform: session.platform_role ?? null };
}

function AdminInner({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { session, canV2 } = useSession();
  const perms = useAdminPerms();
  const platformScope = pathname.startsWith('/admin/platform');
  const groups = useMemo(() => visibleNav(platformScope ? PLATFORM_NAV : WORKSPACE_NAV, perms), [platformScope, perms]);
  const all = useMemo(() => [...visibleNav(WORKSPACE_NAV, perms), ...visibleNav(PLATFORM_NAV, perms)], [perms]);
  const current = activeItem(groups, pathname);
  const [drawer, setDrawer] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [palette, setPalette] = useState(false);
  const workspaceAdmin = canV2('workspace.read');
  const allowed = platformScope ? !!perms.platform : workspaceAdmin || pathname.startsWith('/admin/settings') || pathname === '/admin/help';

  useEffect(() => { setDrawer(false); }, [pathname]);
  // Platform staff without any workspace membership land on the platform scope (the admin app doesn't require one).
  const router = useRouter();
  useEffect(() => { if (!session.workspace && perms.platform && !platformScope) router.replace('/admin/platform'); }, [session.workspace, perms.platform, platformScope, router]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((o) => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sidebar = <Sidebar groups={groups} pathname={pathname} platformScope={platformScope} platform={perms.platform} workspaceAdmin={workspaceAdmin} />;

  return (
    <AdminSyncProvider enabled={workspaceAdmin && !platformScope}>
      <div className="min-h-dvh lg:grid lg:grid-cols-[272px_minmax(0,1fr)]">
        <a href="#admin-main" className="sr-only-focusable fixed left-3 top-3 z-[80] rounded-lg bg-accent px-3 py-2 text-on-accent">Skip to content</a>
        <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-surface lg:flex" aria-label="Admin navigation">{sidebar}</aside>

        <D.Root open={drawer} onOpenChange={setDrawer}>
          <D.Portal>
            <D.Overlay className="anim-fade fixed inset-0 z-50 bg-[var(--overlay)] lg:hidden" />
            <D.Content aria-describedby={undefined} onCloseAutoFocus={(e) => { e.preventDefault(); menuRef.current?.focus(); }} className="anim-slide fixed inset-y-0 left-0 z-50 flex w-[min(320px,88vw)] flex-col border-r border-border bg-surface pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] lg:hidden">
              <D.Title className="sr-only">Admin navigation</D.Title>
              <D.Close asChild>
                <button type="button" aria-label="Close navigation" className="touch-target absolute right-2 top-2.5 inline-flex size-10 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-fg"><X aria-hidden className="size-5" /></button>
              </D.Close>
              {sidebar}
            </D.Content>
          </D.Portal>
        </D.Root>

        <div className="flex min-w-0 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-[color-mix(in_srgb,var(--bg)_94%,transparent)] px-3 pt-[env(safe-area-inset-top)] sm:px-4 md:px-6">
            <button ref={menuRef} type="button" onClick={() => setDrawer(true)} aria-label="Open navigation" aria-expanded={drawer}
              className="touch-target inline-flex size-10 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-fg lg:hidden">
              <MenuIcon aria-hidden className="size-5" />
            </button>
            <Breadcrumbs scope={platformScope ? 'Platform' : session.workspace?.name ?? 'Workspace'} platformScope={platformScope} group={current?.group} item={current?.item} />
            <span className="flex-1" />
            <SyncIndicator />
            <button type="button" onClick={() => setPalette(true)} aria-label="Jump to (Ctrl K)"
              className="touch-target inline-flex h-9 items-center gap-2 rounded-lg border border-border px-2.5 text-[13px] text-muted hover:bg-raised hover:text-fg max-sm:size-10 max-sm:justify-center max-sm:border-0 max-sm:px-0">
              <Search aria-hidden className="size-4" /><span className="max-sm:hidden">Jump to</span><kbd className="rounded border border-border px-1 text-[11px] max-md:hidden">Ctrl K</kbd>
            </button>
            <UserMenu compact />
          </header>
          {session.support_access?.active ? (
            <div role="status" className="border-b border-border bg-info-soft px-4 py-2 text-[13px] text-info md:px-8">
              Support access is active{session.support_access.until ? ` until ${new Date(session.support_access.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}. <Link href="/admin/security/support" className="font-medium underline">Review</Link>
            </div>
          ) : null}
          <main id="admin-main" tabIndex={-1} className="mx-auto w-full max-w-[1280px] flex-1 px-4 pb-[calc(64px+env(safe-area-inset-bottom))] pt-6 focus:outline-none sm:px-6 md:px-8 md:pt-8">
            {allowed ? children : (
              <EmptyState title={platformScope ? 'Platform operators only' : 'Workspace admins only'}
                action={<LinkButton href="/overview" icon={<ArrowLeft aria-hidden className="size-4" />}>Back to Relay</LinkButton>} />
            )}
          </main>
        </div>
        <JumpPalette open={palette} onOpenChange={setPalette} groups={all} />
      </div>
    </AdminSyncProvider>
  );
}

function Breadcrumbs({ scope, platformScope, group, item }: { scope: string; platformScope: boolean; group?: AdminNavGroup; item?: AdminNavItem }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-[13px] text-muted">
        <li className="flex min-w-0 items-center gap-1.5">
          {platformScope ? <ServerCog aria-hidden className="size-4 shrink-0 text-accent-text" /> : <Building2 aria-hidden className="size-4 shrink-0 text-accent-text" />}
          <span className="truncate max-sm:max-w-[110px]">{scope}</span>
        </li>
        {group && group.items.length > 1 ? <li className="flex items-center gap-1 max-md:hidden"><ChevronRight aria-hidden className="size-3.5" />{group.label}</li> : null}
        {item ? <li aria-current="page" className="flex min-w-0 items-center gap-1 text-fg"><ChevronRight aria-hidden className="size-3.5 shrink-0" /><span className="truncate">{item.label}</span></li> : null}
      </ol>
    </nav>
  );
}

const OPEN_KEY = 'sl:admin-nav-open';

function Sidebar({ groups, pathname, platformScope, platform, workspaceAdmin }: { groups: AdminNavGroup[]; pathname: string; platformScope: boolean; platform: AdminPerms['platform']; workspaceAdmin: boolean }) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try { setOpen(JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean>); } catch { /* storage unavailable */ }
  }, []);
  const toggle = (id: string, next: boolean) => {
    setOpen((o) => {
      const v = { ...o, [id]: next };
      try { localStorage.setItem(OPEN_KEY, JSON.stringify(v)); } catch { /* storage unavailable */ }
      return v;
    });
  };
  const f = filter.trim().toLowerCase();
  const shown = f ? groups.map((g) => ({ ...g, items: g.items.filter((i) => `${i.label} ${g.label} ${i.keywords ?? ''}`.toLowerCase().includes(f)) })).filter((g) => g.items.length) : groups;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-5">
        <RelayMark size={22} />
        <span className="text-[15px] font-semibold tracking-tight">Admin</span>
      </div>
      {platform ? (
        <div className="px-3 pb-2" role="group" aria-label="Scope">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-sunken p-1">
            {workspaceAdmin ? (
              <Link href="/admin" aria-current={!platformScope ? 'true' : undefined} className={cn('flex h-9 items-center justify-center gap-1.5 rounded-md text-[13px] font-medium', !platformScope ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg')}>
                <Building2 aria-hidden className="size-3.5" />Workspace
              </Link>
            ) : <span className="flex h-9 items-center justify-center text-[13px] text-subtle">Workspace</span>}
            <Link href="/admin/platform" aria-current={platformScope ? 'true' : undefined} className={cn('flex h-9 items-center justify-center gap-1.5 rounded-md text-[13px] font-medium', platformScope ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg')}>
              <ServerCog aria-hidden className="size-3.5" />Platform
            </Link>
          </div>
        </div>
      ) : null}
      {!platformScope ? <div className="px-3 pb-2"><WorkspaceSwitcher /></div> : null}
      <div className="relative px-3 pb-2">
        <Search aria-hidden className="pointer-events-none absolute left-6 top-1/2 size-4 -translate-y-[calc(50%+4px)] text-subtle" />
        <Input aria-label="Filter navigation" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-9 pl-9 text-[13px]" />
      </div>
      <nav aria-label={platformScope ? 'Platform' : 'Workspace admin'} className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {!shown.length ? <p className="px-2 py-3 text-[13px] text-muted">No matches</p> : null}
        <ul className="flex flex-col gap-0.5">
          {shown.map((g) => {
            if (g.items.length === 1 && !f) {
              const it = g.items[0]!;
              return <NavLink key={g.id} item={{ ...it, label: g.label === it.label || g.id === 'help' || g.id === 'overview' ? it.label : g.label, icon: g.icon }} active={isActiveItem(pathname, it)} />;
            }
            const hasActive = g.items.some((i) => isActiveItem(pathname, i));
            const isOpen = f ? true : open[g.id] ?? hasActive;
            return (
              <li key={g.id}>
                <button type="button" onClick={() => toggle(g.id, !isOpen)} aria-expanded={isOpen} aria-controls={`nav-${g.id}`}
                  className={cn('flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-[14px] font-medium lg:h-9', hasActive ? 'text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg')}>
                  <g.icon aria-hidden strokeWidth={1.75} className={cn('size-[18px] shrink-0', hasActive ? 'text-accent-text' : 'text-subtle')} />
                  <span className="flex-1 truncate text-left">{g.label}</span>
                  <ChevronDown aria-hidden className={cn('size-4 text-subtle transition-transform duration-150', !isOpen && '-rotate-90')} />
                </button>
                {isOpen ? (
                  <ul id={`nav-${g.id}`} className="mb-1 ml-[21px] flex flex-col gap-0.5 border-l border-border pl-2">
                    {g.items.map((i) => <NavLink key={i.href} item={i} active={isActiveItem(pathname, i)} sub />)}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="border-t border-border p-3">
        <Link href="/overview" className="flex h-10 items-center gap-2 rounded-lg px-2.5 text-[13px] text-muted hover:bg-raised hover:text-fg">
          <ArrowLeft aria-hidden className="size-4" />Back to Relay
        </Link>
      </div>
    </div>
  );
}

function NavLink({ item, active, sub }: { item: AdminNavItem; active: boolean; sub?: boolean }) {
  const Icon = item.icon;
  return (
    <li>
      <Link href={item.href} aria-current={active ? 'page' : undefined}
        className={cn('relative flex h-10 items-center gap-3 rounded-lg px-2.5 text-[14px] font-medium transition-colors duration-150 lg:h-9',
          sub && 'text-[13px] lg:h-8', active ? 'bg-raised text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg')}>
        {active ? <span aria-hidden className="absolute -left-[9px] top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-accent" /> : null}
        {!sub ? <Icon aria-hidden strokeWidth={1.75} className={cn('size-[18px] shrink-0', active ? 'text-accent-text' : 'text-subtle')} /> : null}
        <span className="truncate">{item.label}</span>
      </Link>
    </li>
  );
}

function JumpPalette({ open, onOpenChange, groups }: { open: boolean; onOpenChange: (o: boolean) => void; groups: AdminNavGroup[] }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ group: string; item: AdminNavItem }> = [];
    for (const g of groups) for (const i of g.items) if (!seen.has(i.href)) { seen.add(i.href); out.push({ group: g.label, item: i }); }
    const f = q.trim().toLowerCase();
    return f ? out.filter((x) => `${x.item.label} ${x.group} ${x.item.keywords ?? ''}`.toLowerCase().includes(f)) : out;
  }, [groups, q]);
  useEffect(() => { setIdx(0); }, [q, open]);
  const go = (href: string) => { onOpenChange(false); setQ(''); router.push(href); };
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="anim-fade fixed inset-0 z-50 bg-[var(--overlay)]" />
        <D.Content aria-describedby={undefined} className="anim-pop fixed left-1/2 top-[12dvh] z-50 flex max-h-[70dvh] w-[calc(100vw-24px)] max-w-[560px] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow)]">
          <D.Title className="sr-only">Jump to an admin page</D.Title>
          <div className="flex items-center gap-2 border-b border-border px-4">
            <Search aria-hidden className="size-4 text-subtle" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Jump to…" aria-label="Jump to" role="combobox" aria-expanded aria-controls="admin-jump-list"
              aria-activedescendant={items[idx] ? `jump-${idx}` : undefined}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, items.length - 1)); }
                if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
                if (e.key === 'Enter' && items[idx]) { e.preventDefault(); go(items[idx]!.item.href); }
              }}
              className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-subtle" />
          </div>
          <ul id="admin-jump-list" role="listbox" ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
            {!items.length ? <li className="px-3 py-6 text-center text-[13px] text-muted">No matches</li> : items.map((x, i) => (
              <li key={x.item.href} id={`jump-${i}`} role="option" aria-selected={i === idx}>
                <button type="button" onClick={() => go(x.item.href)} onMouseEnter={() => setIdx(i)}
                  className={cn('flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[14px]', i === idx ? 'bg-raised text-fg' : 'text-muted')}>
                  <x.item.icon aria-hidden className="size-4 text-subtle" />
                  <span className="flex-1 truncate">{x.item.label}</span>
                  <span className="truncate text-xs text-subtle">{x.group}</span>
                </button>
              </li>
            ))}
          </ul>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
