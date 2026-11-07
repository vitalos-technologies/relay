'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Download, FileClock } from 'lucide-react';
import { DELIVERY_STATES, DELIVERY_STATE_LABEL, PROVIDERS, PROVIDER_LABEL, resolveWallTime } from '@social-lite/core';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { useBrandFilter, useQueryState } from '@/lib/client/hooks';
import { postTitle } from '@/lib/client/format';
import type { Delivery, HistoryRow, Page } from '@/lib/client/types';
import {
  DeliveryStateBadge, Drawer, EmptyState, ErrorState, Facts, Field, Input, LinkButton, PageHeader, Pagination, PlatformIcon, Select,
  SimulatedBadge, SkeletonRows, Spinner, Table, Td, Th, THead, TimeWithZone, Tr,
} from '@/components/ui';
import { DeliveryCard } from '@/components/deliveries/delivery-card';

function dayStartIso(date: string, tz: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  for (const t of ['00:00', '01:00']) {
    const r = resolveWallTime(`${date}T${t}`, tz);
    if (r.kind === 'ok') return r.instant.toISOString();
    if (r.kind === 'ambiguous') return r.options[0]!.instant.toISOString();
  }
  return null;
}
function nextDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export default function HistoryPage() {
  const { session, can } = useSession();
  const [brand] = useBrandFilter();
  const [params, setParams] = useQueryState();
  const provider = params.get('provider') ?? '';
  const state = params.get('state') ?? '';
  const fromDate = params.get('from') ?? '';
  const toDate = params.get('to') ?? '';
  const tz = session.brands.find((b) => b.id === brand)?.timezone ?? session.workspace?.timezone ?? 'Europe/London';
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [selected, setSelected] = useState<HistoryRow | null>(null);

  const filters = useMemo(() => {
    const q = new URLSearchParams();
    if (brand) q.set('brand_id', brand);
    if (provider) q.set('provider', provider);
    if (state) q.set('state', state);
    const f = fromDate ? dayStartIso(fromDate, tz) : null;
    const t = toDate ? dayStartIso(nextDay(toDate), tz) : null;
    if (f) q.set('from', f);
    if (t) q.set('to', t);
    return q;
  }, [brand, provider, state, fromDate, toDate, tz]);
  const filterKey = filters.toString();
  useEffect(() => setCursors([null]), [filterKey]);
  const cursor = cursors[cursors.length - 1];
  const q = new URLSearchParams(filters);
  if (cursor) q.set('cursor', cursor);
  q.set('limit', '50');
  const { data, error, loading, refetch, refreshing } = useApi<Page<HistoryRow>>(`/api/history?${q}`, { keepPrevious: true });
  const exportHref = `/api/history/export.csv${filterKey ? `?${filterKey}` : ''}`;
  const rangeBad = fromDate && toDate && fromDate > toDate;

  if (!can('history.read')) {
    return <><PageHeader title="History" /><EmptyState icon={<FileClock aria-hidden />} title="No access" /></>;
  }

  return (
    <>
      <PageHeader
        title="History"
        meta={<span className="truncate">{tz.replace(/_/g, ' ')}</span>}
        actions={can('history.export') ? (
          <LinkButton href={exportHref} external download variant="secondary" icon={<Download aria-hidden className="size-4" />}>CSV<span className="sr-only"> export</span></LinkButton>
        ) : null}
      />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Field label="Network">
          <Select value={provider} onChange={(e) => setParams({ provider: e.target.value })}>
            <option value="">All networks</option>
            {PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
          </Select>
        </Field>
        <Field label="Result">
          <Select value={state} onChange={(e) => setParams({ state: e.target.value })}>
            <option value="">All results</option>
            {DELIVERY_STATES.map((s) => <option key={s} value={s}>{DELIVERY_STATE_LABEL[s]}</option>)}
          </Select>
        </Field>
        <Field label="From">
          <Input type="date" value={fromDate} onChange={(e) => setParams({ from: e.target.value })} />
        </Field>
        <Field label="To" error={rangeBad ? '“To” is before “From”.' : null}>
          <Input type="date" value={toDate} onChange={(e) => setParams({ to: e.target.value })} />
        </Field>
      </div>

      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows rows={6} /> : !data?.items.length ? (
        <EmptyState icon={<FileClock aria-hidden />} title={filterKey ? 'No matches' : 'No results yet'} />
      ) : (
        <>
          {refreshing ? <p className="mb-2 text-xs text-subtle" role="status">Updating…</p> : null}
          {/* Desktop table */}
          <div className="hidden md:block">
            <Table caption="Delivery history">
              <THead>
                <tr>
                  <Th>Post</Th>
                  <Th>Destination</Th>
                  <Th>Result</Th>
                  <Th>Scheduled</Th>
                  <Th>Completed</Th>
                  <Th className="text-right">Attempts</Th>
                </tr>
              </THead>
              <tbody>
                {data.items.map((r) => (
                  <Tr key={r.id}>
                    <Td className="max-w-[280px]">
                      <button type="button" onClick={() => setSelected(r)} className="block max-w-full truncate text-left font-medium hover:underline">
                        {postTitle(r)}
                      </button>
                      <span className="block truncate text-xs text-muted">{r.brand_name}</span>
                    </Td>
                    <Td>
                      <span className="flex items-center gap-2">
                        <PlatformIcon provider={r.provider} size="xs" />
                        <span className="max-w-[200px] truncate">{r.display_name}</span>
                        {r.is_mock ? <SimulatedBadge className="shrink-0" /> : null}
                      </span>
                    </Td>
                    <Td><DeliveryStateBadge state={r.state} isMock={r.is_mock} overdue={r.overdue} size="sm" /></Td>
                    <Td className="whitespace-nowrap"><TimeWithZone instant={r.due_at} tz={r.input_timezone || tz} /></Td>
                    <Td className="whitespace-nowrap">{r.published_at ? <TimeWithZone instant={r.published_at} tz={r.input_timezone || tz} /> : <span className="text-muted">—</span>}</Td>
                    <Td className="text-right tabular">{r.attempt_count}/{r.max_attempts}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
          {/* Mobile cards */}
          <ul className="flex flex-col divide-y divide-border md:hidden">
            {data.items.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => setSelected(r)} className="w-full py-3 text-left">
                  <div className="flex items-center gap-3">
                    <PlatformIcon provider={r.provider} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{postTitle(r)}</p>
                      <p className="truncate text-xs text-muted"><TimeWithZone instant={r.published_at ?? r.due_at} tz={r.input_timezone || tz} /> · {r.display_name}</p>
                    </div>
                    <DeliveryStateBadge state={r.state} isMock={r.is_mock} overdue={r.overdue} size="sm" className="shrink-0" />
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <Pagination
            page={cursors.length}
            hasPrev={cursors.length > 1}
            hasNext={!!data.next_cursor}
            loading={refreshing}
            onPrev={() => setCursors((c) => c.slice(0, -1))}
            onNext={() => data.next_cursor && setCursors((c) => [...c, data.next_cursor!])}
          />
        </>
      )}

      <HistoryDrawer row={selected} onClose={() => setSelected(null)} onChanged={() => void refetch()} />
    </>
  );
}

function HistoryDrawer({ row, onClose, onChanged }: { row: HistoryRow | null; onClose: () => void; onChanged: () => void }) {
  // History rows may omit attempts; the post's deliveries endpoint includes them.
  const needAttempts = row && !row.attempts;
  const { data, loading } = useApi<{ items: Delivery[] }>(needAttempts ? `/api/posts/${row.post_id}/deliveries` : null);
  if (!row) return null;
  const full = (data?.items.find((d) => d.id === row.id) ?? row) as Delivery;
  const tz = row.input_timezone;
  return (
    <Drawer open={!!row} onOpenChange={(o) => !o && onClose()} title={postTitle(row)} description={`${row.brand_name} · r${row.revision_number}`}>
      <div className="flex flex-col gap-5">
        <Facts
          items={[
            ['Scheduled', <span key="s" className="tabular">{row.scheduled_input?.replace('T', ' ')} <span className="text-muted">{row.input_timezone}</span></span>],
            ['Due (UTC)', <span key="u" className="font-mono text-[12px]">{row.due_at}</span>],
            ['Published (UTC)', row.published_at ? <span key="p" className="font-mono text-[12px]">{row.published_at}</span> : '—'],
            ['Provider IDs', row.provider_ids.length ? <code key="i" className="font-mono text-[12px]">{row.provider_ids.join(', ')}</code> : '—'],
          ]}
        />
        {loading ? <Spinner label="Loading" /> : null}
        <DeliveryCard key={full.attempts ? 'a' : 'n'} delivery={{ ...row, ...full }} tz={tz} onChanged={onChanged} expandAttempts />
        <Link href={`/posts/${row.post_id}`} className="text-[13px] font-medium underline-offset-2 hover:underline">Open post</Link>
      </div>
    </Drawer>
  );
}
