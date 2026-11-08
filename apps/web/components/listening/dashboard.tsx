'use client';
// Saved listening dashboards: an ordered set of widgets over one brand's saved searches. Each widget loads from the same
// endpoints as the search page and shows its own coverage line (no number without its sources and sample).
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import type { AlertDto, DashboardDto, DashboardWidget, ObservationDto, SavedSearchDto, WidgetType } from '@social-lite/core/contracts/v35-listening';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useBrandFilter } from '@/lib/client/hooks';
import { useSession } from '@/lib/client/session';
import { BarList, Button, Card, CardHeader, Checkbox, ErrorState, Field, IconButton, Input, LineChart, PageHeader, Select, SkeletonRows, useToast } from '@/components/ui';
import { CoverageNote, RANGES, SENTIMENT_LABEL, fmtDay, fmtWhen, pct } from './shared';
import { MentionList } from './mentions';
import type { SentimentResponse, ShareOfVoiceResponse, TimelineResponse, TopicsResponse } from './types';

const WIDGET_LABEL: Record<WidgetType, string> = { timeline: 'Mentions over time', sentiment: 'Sentiment', topics: 'Topics', share_of_voice: 'Share of voice', alerts: 'Alerts', mentions: 'Latest mentions' };

function Widget({ w, names }: { w: DashboardWidget; names: Map<string, string> }) {
  const sid = w.search_ids[0]!;
  const base = `/api/listening/searches/${sid}`;
  const title = w.title || `${WIDGET_LABEL[w.type]} · ${w.type === 'share_of_voice' ? `${w.search_ids.length} searches` : names.get(sid) ?? 'Search'}`;
  const tl = useApi<TimelineResponse>(w.type === 'timeline' ? `${base}/timeline?days=${w.days}` : null);
  const sen = useApi<SentimentResponse>(w.type === 'sentiment' ? `${base}/sentiment?days=${w.days}` : null);
  const top = useApi<TopicsResponse>(w.type === 'topics' ? `${base}/topics?days=${w.days}` : null);
  const sov = useApi<ShareOfVoiceResponse>(w.type === 'share_of_voice' ? `/api/listening/share-of-voice?search_ids=${w.search_ids.join(',')}&days=${w.days}` : null);
  const al = useApi<{ items: AlertDto[] }>(w.type === 'alerts' ? `/api/listening/alerts?search_id=${sid}&limit=5` : null);
  const me = useApi<{ items: ObservationDto[]; coverage: TimelineResponse['coverage'] }>(w.type === 'mentions' ? `${base}/mentions?days=${w.days}&limit=5` : null);
  const err = tl.error ?? sen.error ?? top.error ?? sov.error ?? al.error ?? me.error;
  return (
    <Card className="min-w-0">
      <CardHeader title={title} actions={<span className="text-xs text-muted">{w.days === 1 ? '24 h' : `${w.days} days`}</span>} />
      <div className="px-4 pb-4">
        {err ? <ErrorState error={err} /> : null}
        {w.type === 'timeline' && tl.data ? <>
          <LineChart ariaLabel={title} height={180} labels={tl.data.buckets.map((b) => b.at)} xLabel={(l) => fmtDay(l)} series={[{ key: 'm', label: 'Mentions', color: 'var(--chart-1)', values: tl.data.buckets.map((b) => b.unique) }]} />
          <CoverageNote coverage={tl.data.coverage} compact className="mt-2" />
        </> : null}
        {w.type === 'sentiment' && sen.data ? <>
          <BarList label={title} rows={(['positive', 'neutral', 'negative', 'mixed', 'unscored'] as const).map((l) => ({ key: l, label: SENTIMENT_LABEL[l], value: sen.data!.counts[l] }))} />
          <p className="mt-2 text-xs text-muted">Inferred · negative {pct(sen.data.shares.negative)} of {sen.data.scored} scored</p>
          <CoverageNote coverage={sen.data.coverage} compact className="mt-1" />
        </> : null}
        {w.type === 'topics' && top.data ? <>
          {top.data.topics.length ? <BarList label={title} rows={top.data.topics.map((t) => ({ key: t.label, label: t.label, value: t.count }))} /> : <p className="text-[13px] text-muted">Not enough mentions to group.</p>}
          <CoverageNote coverage={top.data.coverage} compact className="mt-2" />
        </> : null}
        {w.type === 'share_of_voice' && sov.data ? <>
          <BarList label={title} rows={sov.data.rows.map((r) => ({ key: r.search.id, label: `${r.search.name} · ${pct(r.share)}`, value: r.count }))} />
          <p className="mt-2 text-xs text-muted">Observed data only · of {sov.data.denominator}</p>
          <CoverageNote coverage={sov.data.coverage} compact className="mt-1" />
        </> : null}
        {w.type === 'alerts' && al.data ? (al.data.items.length ? (
          <ul className="flex flex-col gap-1">{al.data.items.map((a) => <li key={a.id}><Link className="text-[13px] hover:underline" href={`/listening/alerts/${a.id}`}>{fmtWhen(a.created_at)} · {a.observed} in {a.window.minutes} min</Link></li>)}</ul>
        ) : <p className="text-[13px] text-muted">No alerts.</p>) : null}
        {w.type === 'mentions' && me.data ? <div className="-mx-4"><MentionList items={me.data.items} compact /><CoverageNote coverage={me.data.coverage} compact className="px-4 pt-2" /></div> : null}
        {!err && !(tl.data || sen.data || top.data || sov.data || al.data || me.data) ? <SkeletonRows rows={3} /> : null}
      </div>
    </Card>
  );
}

export function ListeningDashboard({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const [brandFilter] = useBrandFilter();
  const { session, canOn } = useSession();
  const isNew = id === 'new';
  const dash = useApi<DashboardDto>(isNew ? null : `/api/listening/dashboards/${id}`);
  const searches = useApi<{ items: SavedSearchDto[] }>('/api/listening/searches');
  const [edit, setEdit] = useState<{ name: string; shared: boolean; widgets: DashboardWidget[]; brand_id: string } | null>(null);
  const [nw, setNw] = useState<{ type: WidgetType; search_ids: string[]; days: number }>({ type: 'timeline', search_ids: [], days: 30 });
  const names = new Map((searches.data?.items ?? []).map((s) => [s.id, s.name]));
  if (dash.error && !dash.data) return <ErrorState error={dash.error} onRetry={dash.refetch} />;
  const d = dash.data;
  const editing = edit ?? (isNew && searches.data ? { name: '', shared: true, widgets: [], brand_id: brandFilter || session.brands.find((b) => canOn(b.id, 'listening.read'))?.id || '' } : null);
  if (!editing && !d) return <SkeletonRows rows={6} />;
  const brandSearches = (searches.data?.items ?? []).filter((s) => s.brand_id === (editing?.brand_id ?? d?.brand_id));

  const save = async () => {
    if (!editing) return;
    try {
      const r = isNew ? await api.post<DashboardDto>('/api/listening/dashboards', editing) : await api.patch<DashboardDto>(`/api/listening/dashboards/${id}`, { name: editing.name, shared: editing.shared, widgets: editing.widgets });
      toast.success('Dashboard saved');
      setEdit(null);
      if (isNew) router.push(`/listening/dashboards/${r.id}`); else await dash.refetch();
    } catch (e) { toast.error(e); }
  };
  const setE = (patch: Partial<NonNullable<typeof editing>>) => setEdit({ ...editing!, ...patch });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={<Link href="/listening" className="inline-flex items-center gap-1 hover:text-fg"><ArrowLeft aria-hidden className="size-3.5" />Listening</Link>}
        title={editing ? (isNew ? 'New dashboard' : `Edit ${d?.name ?? ''}`) : d!.name}
        meta={!editing && d && !d.shared ? 'Only you' : undefined}
        actions={editing ? <>
          {!isNew ? <Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button> : null}
          <Button variant="primary" onClick={save} disabled={!editing.name.trim() || !editing.brand_id}>Save</Button>
        </> : d?.can_manage ? <>
          <Button variant="secondary" onClick={() => setEdit({ name: d.name, shared: d.shared, widgets: d.widgets, brand_id: d.brand_id })}>Edit</Button>
          <Button variant="ghost" onClick={async () => { try { await api.del(`/api/listening/dashboards/${id}`); router.push('/listening'); } catch (e) { toast.error(e); } }}>Delete</Button>
        </> : undefined} />
      {editing ? (
        <Card className="flex flex-col gap-4 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name"><Input value={editing.name} onChange={(e) => setE({ name: e.target.value })} maxLength={80} /></Field>
            {isNew ? <Field label="Brand"><Select value={editing.brand_id} onChange={(e) => setE({ brand_id: e.target.value, widgets: [] })}>{session.brands.filter((b) => canOn(b.id, 'listening.read')).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field> : null}
          </div>
          <Checkbox label="Shared with the team" checked={editing.shared} onChange={(e) => setE({ shared: e.target.checked })} />
          <ul className="flex flex-col gap-2">
            {editing.widgets.map((w, i) => (
              <li key={i} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate">{WIDGET_LABEL[w.type]} · {w.search_ids.map((s) => names.get(s) ?? s).join(', ')} · {w.days} d</span>
                <IconButton label="Remove widget" icon={<Trash2 aria-hidden />} onClick={() => setE({ widgets: editing.widgets.filter((_, j) => j !== i) })} />
              </li>
            ))}
          </ul>
          <div className="grid gap-3 rounded-md bg-sunken p-3 sm:grid-cols-[1fr_1fr_120px_auto] sm:items-end">
            <Field label="Widget"><Select value={nw.type} onChange={(e) => setNw({ ...nw, type: e.target.value as WidgetType, search_ids: [] })}>{(Object.keys(WIDGET_LABEL) as WidgetType[]).map((t) => <option key={t} value={t}>{WIDGET_LABEL[t]}</option>)}</Select></Field>
            {nw.type === 'share_of_voice' ? (
              <fieldset className="flex flex-col gap-1.5"><legend className="mb-1 text-[13px] font-medium">Searches</legend>{brandSearches.map((s) => <Checkbox key={s.id} label={s.name} checked={nw.search_ids.includes(s.id)} onChange={() => setNw({ ...nw, search_ids: nw.search_ids.includes(s.id) ? nw.search_ids.filter((x) => x !== s.id) : [...nw.search_ids, s.id] })} />)}</fieldset>
            ) : (
              <Field label="Search"><Select value={nw.search_ids[0] ?? ''} onChange={(e) => setNw({ ...nw, search_ids: e.target.value ? [e.target.value] : [] })}><option value="">Choose…</option>{brandSearches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
            )}
            <Field label="Period"><Select value={String(nw.days)} onChange={(e) => setNw({ ...nw, days: Number(e.target.value) })}>{RANGES.map((r) => <option key={r} value={r}>{r === 1 ? '24 h' : `${r} d`}</option>)}</Select></Field>
            <Button variant="secondary" icon={<Plus aria-hidden />} disabled={nw.search_ids.length < (nw.type === 'share_of_voice' ? 2 : 1) || editing.widgets.length >= 12}
              onClick={() => { setE({ widgets: [...editing.widgets, { ...nw }] }); setNw({ ...nw, search_ids: [] }); }}>Add</Button>
          </div>
        </Card>
      ) : null}
      {!editing && d ? (d.widgets.length ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">{d.widgets.map((w, i) => <Widget key={i} w={w} names={names} />)}</div>
      ) : <p className="text-[13px] text-muted">No widgets yet.</p>) : null}
    </div>
  );
}
