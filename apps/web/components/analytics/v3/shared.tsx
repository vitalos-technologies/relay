'use client';
// Analytics (V3) shared pieces: URL-backed filters (contract FILTER_QUERY_KEYS), view tabs, data-health footer.
// Coverage/freshness is explained once per view (footer), never as per-row "unavailable" badges.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import { FlaskConical } from 'lucide-react';
import { PROVIDER_LABEL, type Provider } from '@social-lite/core';
import {
  FILTER_QUERY_KEYS, POST_FORMATS, type AnalyticsDataset, type DataHealth, type ResponseMeta, type SeriesHealth,
} from '@social-lite/core/contracts/analytics';
import { useSession } from '@/lib/client/session';
import { useQueryState } from '@/lib/client/hooks';
import { localDateKey } from '@/lib/client/format';
import { Banner, cn, CoverageMeter, FilterBar, FilterSelect, Segmented, Switch } from '@/components/ui';

export const VIEWS = [
  { slug: '', label: 'Overview' },
  { slug: 'content', label: 'Content' },
  { slug: 'channels', label: 'Channels' },
  { slug: 'video', label: 'Video' },
  { slug: 'audience', label: 'Audience' },
  { slug: 'workflow', label: 'Workflow' },
] as const;

const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** Filters from the URL; demo workspaces default to the demo dataset (live stays empty there). */
export function useAnalyticsQuery(extra: string[] = []) {
  const { session } = useSession();
  const [params, setParams] = useQueryState();
  const dataset = (params.get('dataset') as AnalyticsDataset | null) ?? (session.workspace?.is_demo ? 'demo' : 'live');
  const qs = useMemo(() => {
    const q = new URLSearchParams();
    for (const k of [...FILTER_QUERY_KEYS, ...extra]) {
      const v = params.get(k);
      if (v) q.set(k, v);
    }
    if (dataset !== 'live') q.set('dataset', dataset); else q.delete('dataset');
    return q.toString();
  }, [params, dataset, extra.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  return { qs, params, setParams, dataset };
}

export function fmtDay(d: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) {
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
}

export function AnalyticsTabs() {
  const pathname = usePathname();
  const [params] = useQueryState();
  const keep = new URLSearchParams();
  for (const k of [...FILTER_QUERY_KEYS]) { const v = params.get(k); if (v) keep.set(k, v); }
  const suffix = keep.toString() ? `?${keep}` : '';
  return (
    <nav aria-label="Analytics views" className="-mx-4 mb-5 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 border-b border-border">
        {VIEWS.map((v) => {
          const href = `/analytics${v.slug ? `/${v.slug}` : ''}`;
          const active = pathname === href;
          return (
            <li key={v.slug}>
              <Link href={`${href}${suffix}`} aria-current={active ? 'page' : undefined}
                className={cn('relative -mb-px inline-flex h-10 items-center border-b-2 px-3 text-[13px] font-medium transition-colors',
                  active ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}>
                {v.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** One row of filters; every change rewrites the URL, so views are shareable and the back button works. */
export function AnalyticsFilters({ meta, showFormat = true, end }: { meta?: ResponseMeta | null; showFormat?: boolean; end?: ReactNode }) {
  const { session } = useSession();
  const { params, setParams, dataset } = useAnalyticsQuery();
  const tz = meta?.period.timezone ?? session.workspace?.timezone ?? 'Europe/London';
  const today = localDateKey(new Date(), tz);
  const from = params.get('from');
  const to = params.get('to');
  const days = meta?.period.days ?? 28;
  const preset = !from && !to ? '28' : to === today && from ? (['7', '28', '90'].find((d) => addDays(today, -(Number(d) - 1)) === from) ?? 'custom') : 'custom';
  const accounts = meta?.scope.accounts ?? [];
  const networks = [...new Set(accounts.map((a) => a.provider))] as Provider[];
  const datasets: Array<{ value: AnalyticsDataset; label: string }> = [
    { value: 'live', label: 'Live data' },
    ...(session.mock_providers_enabled ? [{ value: 'simulated' as const, label: 'Simulated' }] : []),
    ...(session.workspace?.is_demo ? [{ value: 'demo' as const, label: 'Demo data' }] : []),
  ];
  return (
    <FilterBar end={end}>
      <Segmented
        size="sm"
        label="Period"
        value={preset}
        onChange={(v) => v === 'custom'
          ? setParams({ from: meta?.period.from ?? addDays(today, -27), to: meta?.period.to ?? today })
          : setParams({ from: v === '28' ? null : addDays(today, -(Number(v) - 1)), to: v === '28' ? null : today })}
        options={[{ value: '7', label: '7d' }, { value: '28', label: '28d' }, { value: '90', label: '90d' }, { value: 'custom', label: 'Custom' }]}
      />
      {preset === 'custom' ? (
        <span className="flex items-center gap-1.5">
          <label className="sr-only" htmlFor="an-from">From</label>
          <input id="an-from" type="date" value={from ?? meta?.period.from ?? ''} max={to ?? today} onChange={(e) => e.target.value && setParams({ from: e.target.value })}
            className="h-8 rounded-lg border border-border bg-surface px-2 text-[13px] tabular" />
          <span aria-hidden className="text-muted">–</span>
          <label className="sr-only" htmlFor="an-to">To</label>
          <input id="an-to" type="date" value={to ?? meta?.period.to ?? ''} min={from ?? undefined} max={today} onChange={(e) => e.target.value && setParams({ to: e.target.value })}
            className="h-8 rounded-lg border border-border bg-surface px-2 text-[13px] tabular" />
        </span>
      ) : null}
      <FilterSelect id="an-network" label="Network" className="w-[150px]" value={params.get('network') ?? ''} onChange={(v) => setParams({ network: v, account: null })}>
        <option value="">All networks</option>
        {networks.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
      </FilterSelect>
      <FilterSelect id="an-account" label="Account" className="w-[180px]" value={params.get('account') ?? ''} onChange={(v) => setParams({ account: v })}>
        <option value="">All accounts</option>
        {accounts.filter((a) => !params.get('network') || a.provider === params.get('network')).map((a) => (
          <option key={a.connection_id} value={a.connection_id}>{PROVIDER_LABEL[a.provider]} · {a.display_name}</option>
        ))}
      </FilterSelect>
      {showFormat ? (
        <FilterSelect id="an-format" label="Format" className="w-[130px]" value={params.get('format') ?? ''} onChange={(v) => setParams({ format: v })}>
          <option value="">All formats</option>
          {POST_FORMATS.map((f) => <option key={f} value={f}>{f[0]!.toUpperCase() + f.slice(1)}</option>)}
        </FilterSelect>
      ) : null}
      {datasets.length > 1 ? (
        <FilterSelect id="an-dataset" label="Data" className="w-[130px]" value={dataset} onChange={(v) => setParams({ dataset: v === 'live' && !session.workspace?.is_demo ? null : v })}>
          {datasets.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
        </FilterSelect>
      ) : null}
      <Switch className="ml-1" checked={params.get('compare') !== 'none'} onCheckedChange={(v) => setParams({ compare: v ? null : 'none' })} label={<span className="text-[13px]">Compare</span>} />
      <span className="sr-only" aria-live="polite">{days} days</span>
    </FilterBar>
  );
}

/** Shown once at the top when the dataset is not live. */
export function DatasetNotice({ meta }: { meta?: ResponseMeta | null }) {
  if (!meta || meta.dataset === 'live') return null;
  return (
    <Banner tone="neutral" className="mb-5" icon={<FlaskConical aria-hidden className="size-4 text-muted" />}
      title={meta.dataset === 'demo' ? 'Demo data — synthetic, not network-reported' : 'Simulated destinations — nothing was sent to a network'} />
  );
}

/** Coverage + freshness for the whole view, once. */
export function HealthFooter({ health, notes }: { health: Pick<DataHealth, 'coverage' | 'freshness'> & Partial<Pick<DataHealth, 'statuses' | 'notes'>> | SeriesHealth | null | undefined; notes?: string[] }) {
  if (!health) return null;
  const c = health.coverage;
  const f = health.freshness;
  const statuses = 'statuses' in health && health.statuses ? health.statuses : 'reasons' in health ? health.reasons : [];
  const grouped = new Map<string, number>();
  for (const s of statuses) grouped.set(s.status, (grouped.get(s.status) ?? 0) + s.count);
  const LABEL: Record<string, string> = {
    unsupported: 'not provided by the network', permission_missing: 'missing permission', not_fetched: 'not fetched yet', stale: 'stale',
    provider_delayed: 'delayed by the network', partial_coverage: 'partial', fetch_failed: 'fetch failed', zero: 'reported zero',
  };
  const allNotes = [...new Set([...(notes ?? []), ...('notes' in health && health.notes ? health.notes : [])])].filter((n) => !/^Synthetic demo data/.test(n));
  return (
    <footer className="mt-8 flex flex-col gap-2 border-t border-border pt-4 text-xs text-muted">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <CoverageMeter ratio={c.ratio} label={`${c.with_data} of ${c.eligible} ${c.unit} with data`} />
        {c.unsupported ? <span>{c.unsupported} {c.unit} on networks without this measure</span> : null}
        {f.through_date ? <span>Complete through {fmtDay(f.through_date, { day: 'numeric', month: 'short', year: 'numeric' })}</span> : null}
        {f.last_sync_at ? <span>Last sync {new Date(f.last_sync_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span> : null}
        {[...grouped.entries()].filter(([k]) => k !== 'partial_coverage').map(([k, n]) => <span key={k}>{n} {LABEL[k] ?? k}</span>)}
      </div>
      {allNotes.length ? <ul className="flex flex-col gap-0.5">{allNotes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
    </footer>
  );
}

export function ProviderName({ p }: { p: Provider }) {
  return <>{PROVIDER_LABEL[p]}</>;
}
