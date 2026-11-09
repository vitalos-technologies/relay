'use client';
// Activity / security centre: filterable audit trail (permissions, connections, publishing, security)
// with cursor pagination and a permitted CSV export (audit.read + exports.create).
import { useEffect, useMemo, useState } from 'react';
import { Download, ShieldCheck } from 'lucide-react';
import { isApiError } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useDebouncedValue, useQueryState } from '@/lib/client/hooks';
import { useSession } from '@/lib/client/session';
import {
  Badge, Button, Drawer, EmptyState, ErrorState, Facts, Field, Input, PageHeader, Pagination, Segmented, Select, SkeletonRows,
  Table, Td, Th, THead, TimeWithZone, Tr, useToast,
} from '@/components/ui';
import { postDownload } from '@/components/product/download';

type Category = 'all' | 'permissions' | 'connections' | 'publishing' | 'security' | 'collaboration' | 'care' | 'content';
interface Event {
  id: string; category: Category; action: string; resource_type: string; resource_id: string | null; brand_id: string | null; brand_name: string | null;
  actor: string; actor_user_id: string | null; diff: Record<string, unknown>; correlation_id: string | null; created_at: string;
}
interface ActivityPage { items: Event[]; next_cursor: string | null; can_export: boolean }

const CATS: Array<{ value: Category; label: string }> = [
  { value: 'all', label: 'All' }, { value: 'permissions', label: 'Access' }, { value: 'connections', label: 'Accounts' },
  { value: 'publishing', label: 'Publishing' }, { value: 'security', label: 'Security' }, { value: 'collaboration', label: 'Collaboration' }, { value: 'care', label: 'Inbox and AI' }, { value: 'content', label: 'Content' },
];
const TONE: Record<Category, 'info' | 'warn' | 'danger' | 'success' | 'neutral' | 'accent'> = {
  all: 'neutral', permissions: 'warn', connections: 'info', publishing: 'success', security: 'danger', collaboration: 'accent', care: 'info', content: 'neutral',
};
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function summary(e: Event): string {
  const d = e.diff ?? {};
  const keys = Object.keys(d).filter((k) => !['changes'].includes(k)).slice(0, 3);
  const parts = keys.map((k) => `${k.replace(/_/g, ' ')}: ${typeof d[k] === 'object' ? JSON.stringify(d[k]).slice(0, 40) : String(d[k]).slice(0, 40)}`);
  if (Array.isArray(d.changes)) parts.unshift(`${(d.changes as unknown[]).length} change${(d.changes as unknown[]).length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export default function ActivityPage() {
  const { session } = useSession();
  const toast = useToast();
  const [params, setParams] = useQueryState();
  const category = (params.get('category') ?? 'all') as Category;
  const brand = params.get('brand_id') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const [text, setText] = useState(params.get('q') ?? '');
  const q = useDebouncedValue(text.trim(), 300);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [selected, setSelected] = useState<Event | null>(null);
  const [exporting, setExporting] = useState(false);
  const tz = session.workspace?.timezone ?? 'UTC';

  const filters = useMemo(() => {
    const f: Record<string, string> = { category };
    if (brand) f.brand_id = brand;
    if (q) f.q = q;
    if (isDate(from)) f.from = new Date(`${from}T00:00:00Z`).toISOString();
    if (isDate(to)) f.to = new Date(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000).toISOString();
    return f;
  }, [category, brand, q, from, to]);
  const key = JSON.stringify(filters);
  useEffect(() => setCursors([null]), [key]);
  const cursor = cursors[cursors.length - 1];
  const qs = new URLSearchParams({ ...filters, limit: '50', ...(cursor ? { cursor } : {}) });
  const { data, error, loading, refetch } = useApi<ActivityPage>(`/api/activity?${qs}`, { keepPrevious: true });

  if (error && isApiError(error) && (error.code === 'forbidden' || error.code === 'mfa_required')) {
    return <><PageHeader title="Audit log" /><EmptyState icon={<ShieldCheck aria-hidden />} title="Owners and admins only" /></>;
  }

  const doExport = async () => {
    setExporting(true);
    try {
      const r = await postDownload('/api/activity/export', filters, session.csrf_token);
      toast.success('Export downloaded', r.filename);
    } catch (e) {
      toast.error(e, 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        actions={data?.can_export ? <Button variant="secondary" icon={<Download aria-hidden className="size-4" />} onClick={doExport} loading={exporting}>Export CSV</Button> : null}
      />
      <div className="mb-4 flex flex-col gap-4">
        <div className="-mx-1 overflow-x-auto px-1"><Segmented label="Category" value={category} onChange={(v) => setParams({ category: v === 'all' ? null : v })} options={CATS} size="sm" /></div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Field label="Search" labelHidden><Input type="search" placeholder="Action, resource or person" value={text} onChange={(e) => { setText(e.target.value); setParams({ q: e.target.value || null }); }} /></Field>
          <Field label="Brand" labelHidden>
            <Select value={brand} onChange={(e) => setParams({ brand_id: e.target.value || null })}>
              <option value="">All brands</option>
              {session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </Field>
          <Field label="From" labelHidden><Input type="date" aria-label="From" value={from} onChange={(e) => setParams({ from: e.target.value || null })} /></Field>
          <Field label="To" labelHidden><Input type="date" aria-label="To" value={to} onChange={(e) => setParams({ to: e.target.value || null })} /></Field>
        </div>
      </div>
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : !data ? <SkeletonRows rows={6} /> : !data.items.length ? (
        <EmptyState icon={<ShieldCheck aria-hidden />} title="No events" />
      ) : (
        <>
          <Table caption="Audit log">
            <THead>
              <Tr><Th>When</Th><Th>Type</Th><Th>Action</Th><Th className="hidden md:table-cell">By</Th><Th className="hidden lg:table-cell">Brand</Th><Th className="hidden xl:table-cell">Details</Th></Tr>
            </THead>
            <tbody>
              {data.items.map((e) => (
                <Tr key={e.id} onClick={() => setSelected(e)} className="cursor-pointer">
                  <Td className="whitespace-nowrap text-xs"><TimeWithZone instant={e.created_at} tz={tz} /></Td>
                  <Td><Badge tone={TONE[e.category]}>{CATS.find((c) => c.value === e.category)?.label ?? e.category}</Badge></Td>
                  <Td className="font-mono text-[12px]">{e.action}</Td>
                  <Td className="hidden max-w-[220px] truncate text-[13px] md:table-cell">{e.actor}</Td>
                  <Td className="hidden text-[13px] text-muted lg:table-cell">{e.brand_name ?? '—'}</Td>
                  <Td className="hidden max-w-[360px] truncate text-xs text-muted xl:table-cell">{summary(e)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={cursors.length} hasPrev={cursors.length > 1} hasNext={!!data.next_cursor} loading={loading}
            onPrev={() => setCursors((c) => c.slice(0, -1))} onNext={() => data.next_cursor && setCursors((c) => [...c, data.next_cursor])} />
        </>
      )}
      <Drawer open={!!selected} onOpenChange={(o) => !o && setSelected(null)} title={selected?.action ?? ''}>
        {selected ? (
          <div className="flex flex-col gap-4">
            <Facts items={[
              ['When', <TimeWithZone key="t" instant={selected.created_at} tz={tz} />],
              ['By', selected.actor],
              ['Brand', selected.brand_name ?? '—'],
              ['Resource', `${selected.resource_type}${selected.resource_id ? ` · ${selected.resource_id}` : ''}`],
              ['Reference', <code key="c" className="font-mono text-[11px]">{selected.correlation_id ?? '—'}</code>],
            ]} />
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-sunken p-3 font-mono text-[12px]">{JSON.stringify(selected.diff ?? {}, null, 2)}</pre>
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
