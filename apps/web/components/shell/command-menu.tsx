'use client';
// V3.1 §8 global search + command menu (Cmd/Ctrl+K). Keyboard first: ↑/↓ move, Enter opens, Esc closes.
//  - GET /api/search (debounced SEARCH_DEBOUNCE_MS, previous request aborted → the server cancels its query).
//  - Results are authorized server-side per item; snippets are rendered as text (never HTML).
//  - The in-memory cache is keyed by workspace + policy version + query and dropped when either changes; a response
//    for another workspace is discarded. Nothing is persisted.
//  - Empty query: quick actions + recent items (GET /api/search/recent, re-authorized on every read).
import * as D from '@radix-ui/react-dialog';
import { useRouter } from 'next/navigation';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CalendarDays, CornerDownLeft, FileText, Flag, Image as ImageIcon, LoaderCircle, Search, Settings, SquarePen, Tag, Trash2, type LucideIcon,
} from 'lucide-react';
import { SEARCH_DEBOUNCE_MS, type RecentItemsResponse, type SearchKind, type SearchResponse, type SearchResult } from '@social-lite/core/contracts/v31-data';
import { api, isApiError } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { useBrandFilter } from '@/lib/client/hooks';
import { fmtDateTime } from '@/lib/client/format';
import type { PostDetail } from '@/lib/client/types';
import { cn, useToast } from '@/components/ui';

const KIND_LABEL: Record<SearchKind, string> = { post: 'Posts', campaign: 'Campaigns', asset: 'Assets', brand: 'Brands', setting: 'Settings' };
const KIND_ICON: Record<SearchKind, LucideIcon> = { post: FileText, campaign: Flag, asset: ImageIcon, brand: Tag, setting: Settings };
const KIND_ORDER: SearchKind[] = ['post', 'campaign', 'asset', 'brand', 'setting'];

interface Row {
  id: string;
  group: string;
  icon: LucideIcon;
  title: string;
  hint?: string | null;
  snippet?: { text: string; highlights: Array<[number, number]> } | null;
  run: () => void | Promise<void>;
}

// Per tab, in memory only. Key = workspace:policy:query.
const cache = new Map<string, SearchResponse>();
let cacheScope = '';

const OPEN_EVENT = 'relay:open-command-menu';
export function openCommandMenu() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function CommandMenu() {
  const { session, canOn, canV2 } = useSession();
  const router = useRouter();
  const toast = useToast();
  const [brandFilter] = useBrandFilter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [recent, setRecent] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [active, setActive] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const workspaceId = session.workspace?.id ?? '';
  const policyVersion = session.v2?.policy_version ?? 0;
  const scope = `${workspaceId}:${policyVersion}`;

  // Workspace or policy changed: nothing from before may be shown.
  useEffect(() => {
    if (cacheScope !== scope) { cache.clear(); cacheScope = scope; }
    setRes(null);
    setRecent(null);
  }, [scope]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener(OPEN_EVENT, onOpen); };
  }, []);

  // Recent items each time the menu opens (re-authorized server-side).
  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    api.get<RecentItemsResponse>('/api/search/recent', { limit: 6 }, { signal: ctl.signal })
      .then((r) => { if (r.workspace_id === workspaceId) setRecent(r.items); })
      .catch(() => { /* recent is optional */ });
    return () => ctl.abort();
  }, [open, workspaceId]);

  // Debounced, cancellable search.
  const term = q.trim();
  useEffect(() => {
    abort.current?.abort();
    setError(null);
    if (!open || term.length < 2) { setRes(null); setLoading(false); return; }
    const key = `${scope}:${term.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit) { setRes(hit); setLoading(false); return; }
    setLoading(true);
    const ctl = new AbortController();
    abort.current = ctl;
    const t = setTimeout(async () => {
      try {
        const r = await api.get<SearchResponse>('/api/search', { q: term, limit: 5 }, { signal: ctl.signal });
        if (ctl.signal.aborted) return;
        if (r.workspace_id !== workspaceId) return; // never show another workspace's results
        if (r.policy_version !== policyVersion) cache.clear();
        else cache.set(key, r);
        if (cache.size > 50) cache.delete(cache.keys().next().value as string);
        setRes(r);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError' || ctl.signal.aborted) return;
        setError(e);
      } finally {
        if (!ctl.signal.aborted) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [term, open, scope, workspaceId, policyVersion]);

  const close = useCallback(() => setOpen(false), []);
  useEffect(() => { if (!open) { setQ(''); setActive(0); abort.current?.abort(); } }, [open]);

  const go = useCallback((r: SearchResult) => {
    if (r.kind !== 'setting') void api.post('/api/search/recent', { kind: r.kind, id: r.id }).catch(() => undefined);
    close();
    router.push(r.href);
  }, [close, router]);

  // ---- quick actions (permission-filtered for display; the server authorizes the action itself)
  const createBrands = session.brands.filter((b) => canOn(b.id, 'content.create'));
  const defaultBrand = createBrands.find((b) => b.id === brandFilter) ?? createBrands[0];
  const newDraft = useCallback(async (brandId: string) => {
    try {
      const p = await api.post<PostDetail>(`/api/brands/${brandId}/posts`, {}, { idempotent: true });
      close();
      router.push(`/posts/${p.id}`);
    } catch (e) {
      toast.error(e, 'Couldn’t create draft');
    }
  }, [close, router, toast]);

  const actions = useMemo<Row[]>(() => {
    const list: Row[] = [];
    if (defaultBrand) list.push({ id: 'a:new', group: 'Actions', icon: SquarePen, title: 'Create draft', hint: createBrands.length > 1 ? defaultBrand.name : null, run: () => newDraft(defaultBrand.id) });
    if (term && createBrands.length > 1) {
      for (const b of createBrands) if (b.id !== defaultBrand?.id && b.name.toLowerCase().includes(term.toLowerCase())) {
        list.push({ id: `a:new:${b.id}`, group: 'Actions', icon: SquarePen, title: `Create draft in ${b.name}`, run: () => newDraft(b.id) });
      }
    }
    list.push({ id: 'a:planner', group: 'Actions', icon: CalendarDays, title: 'Open planner', run: () => { close(); router.push('/planner'); } });
    if (canV2('content.read')) list.push({ id: 'a:trash', group: 'Actions', icon: Trash2, title: 'Open trash', run: () => { close(); router.push('/trash'); } });
    if (!term) return list;
    const t = term.toLowerCase();
    return list.filter((a) => a.id.startsWith('a:new:') || a.title.toLowerCase().includes(t) || 'new create draft post'.includes(t) && a.id === 'a:new');
  }, [defaultBrand, createBrands, term, newDraft, close, router, canV2]);

  const rows = useMemo<Row[]>(() => {
    // Same-titled items get a date (and time when the date matches too) so they don't look like duplicates.
    const all = !term || term.length < 2 ? recent ?? [] : res?.results ?? [];
    const count = new Map<string, number>();
    for (const r of all) count.set(`${r.kind}:${r.title}`, (count.get(`${r.kind}:${r.title}`) ?? 0) + 1);
    const tz = session.workspace?.timezone ?? 'UTC';
    const when = (r: SearchResult) => {
      const at = typeof r.meta.updated_at === 'string' ? r.meta.updated_at : null;
      if (!at || (count.get(`${r.kind}:${r.title}`) ?? 0) < 2) return null;
      return `Edited ${fmtDateTime(at, tz)}`;
    };
    const toRow = (r: SearchResult, group: string): Row => ({
      id: `${group}:${r.kind}:${r.id}`, group, icon: KIND_ICON[r.kind], title: r.title,
      hint: [
        r.kind === 'post' && r.meta.archived ? 'Archived' : r.brand_id && r.kind !== 'brand' ? session.brands.find((b) => b.id === r.brand_id)?.name ?? null : null,
        when(r),
      ].filter(Boolean).join(' · ') || null,
      snippet: r.snippet ? { text: r.snippet, highlights: r.highlights } : null,
      run: () => go(r),
    });
    if (!term || term.length < 2) return [...actions, ...(recent ?? []).map((r) => toRow(r, 'Recent'))];
    const found = res ? KIND_ORDER.flatMap((k) => res.results.filter((r) => r.kind === k).map((r) => toRow(r, KIND_LABEL[k]))) : [];
    return [...found, ...actions];
  }, [term, actions, recent, res, go, session.brands, session.workspace?.timezone]);

  useEffect(() => { setActive(0); }, [rows.length, term]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(rows.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(rows.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); void rows[active]?.run(); }
  };

  const searching = term.length >= 2;
  const empty = searching && !loading && res && res.results.length === 0;
  let lastGroup = '';
  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="anim-fade fixed inset-0 z-[60] bg-[var(--overlay)]" />
        <D.Content
          aria-describedby={undefined}
          className="anim-pop fixed left-1/2 top-[12dvh] z-[60] flex max-h-[min(70dvh,560px)] w-[calc(100vw-24px)] max-w-[640px] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow)] max-sm:top-3"
        >
          <D.Title className="sr-only">Search and commands</D.Title>
          <div className="flex items-center gap-3 border-b border-border px-4">
            {loading ? <LoaderCircle aria-hidden className="size-4 shrink-0 anim-spin text-muted" /> : <Search aria-hidden className="size-4 shrink-0 text-muted" />}
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value.slice(0, 100))}
              onKeyDown={onKeyDown}
              placeholder="Search or jump to…"
              role="combobox"
              aria-expanded
              aria-controls="cmdk-list"
              aria-autocomplete="list"
              aria-activedescendant={rows[active] ? `cmdk-${active}` : undefined}
              aria-label="Search posts, campaigns, assets, brands and settings"
              className="h-14 min-w-0 flex-1 bg-transparent text-[15px] placeholder:text-subtle focus:outline-none"
            />
            <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-[11px] text-muted sm:inline">Esc</kbd>
          </div>
          <div ref={listRef} id="cmdk-list" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-2">
            {rows.map((r, i) => {
              const header = r.group !== lastGroup ? r.group : null;
              lastGroup = r.group;
              return (
                <Fragment key={r.id}>
                  {header ? <div role="presentation" className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.06em] text-subtle">{header}</div> : null}
                  <div
                    id={`cmdk-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === active}
                    onMouseMove={() => setActive(i)}
                    onClick={() => void r.run()}
                    className={cn('flex cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2', i === active ? 'bg-raised' : '')}
                  >
                    <r.icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', i === active ? 'text-accent-text' : 'text-subtle')} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="max-w-[70%] shrink-0 truncate text-[14px]">{r.title}</span>
                        {r.hint ? <span className="min-w-0 truncate text-xs text-muted">{r.hint}</span> : null}
                      </div>
                      {r.snippet ? <p className="mt-0.5 line-clamp-1 text-xs text-muted"><Highlighted text={r.snippet.text} ranges={r.snippet.highlights} /></p> : null}
                    </div>
                    {i === active ? <CornerDownLeft aria-hidden className="mt-0.5 size-3.5 shrink-0 text-subtle" /> : null}
                  </div>
                </Fragment>
              );
            })}
            {empty ? <p className="px-3 py-6 text-center text-[13px] text-muted">No results for “{term}”</p> : null}
            {error ? <p role="alert" className="px-3 py-3 text-[13px] text-danger">{isApiError(error) ? error.message : 'Search failed. Try again.'}</p> : null}
          </div>
          <Footer>
            {res?.partial ? <span className="text-warn">Partial results</span> : res?.truncated.length ? <span>More matches — refine your search</span> : <span><Kbd>↑</Kbd><Kbd>↓</Kbd> move · <Kbd>↵</Kbd> open</span>}
          </Footer>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted">{children}</div>;
}
function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mx-0.5 rounded border border-border px-1 text-[11px]">{children}</kbd>;
}

/** Plain-text snippet with [start, end) highlight ranges. Never HTML. */
function Highlighted({ text, ranges }: { text: string; ranges: Array<[number, number]> }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (s < at || s >= e || e > text.length) continue;
    if (s > at) parts.push(text.slice(at, s));
    parts.push(<mark key={s} className="rounded-sm bg-accent-soft px-0.5 text-fg">{text.slice(s, e)}</mark>);
    at = e;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/** Top-bar trigger. */
export function SearchTrigger() {
  const [mac, setMac] = useState(false);
  useEffect(() => { setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)); }, []);
  return (
    <button
      type="button"
      onClick={openCommandMenu}
      aria-label="Search"
      aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'}
      className="touch-target inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-[13px] text-muted hover:bg-raised hover:text-fg max-sm:w-9 max-sm:justify-center max-sm:px-0 sm:min-w-[200px]"
    >
      <Search aria-hidden className="size-4" />
      <span className="hidden flex-1 text-left sm:inline">Search</span>
      <kbd className="hidden rounded border border-border px-1.5 text-[11px] sm:inline">{mac ? '⌘K' : 'Ctrl K'}</kbd>
    </button>
  );
}
