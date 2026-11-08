'use client';
// One saved search: volume timeline (not-collected periods are gaps, never zeros), sentiment with uncertainty, topics,
// mentions with corrections and insight actions, spike alert rules. Every block states its coverage.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowLeft, BellPlus, Ellipsis, Pencil, Search } from 'lucide-react';
import type { AlertDto, AlertRuleDto, ObservationDto, SavedSearchDto, SearchDefinition } from '@social-lite/core/contracts/v35-listening';
import { LISTENING_DEFINITIONS, tokenize } from '@social-lite/core/contracts/v35-listening';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useDebouncedValue, useQueryState } from '@/lib/client/hooks';
import { useSession } from '@/lib/client/session';
import {
  Badge, BarList, Button, Card, CardHeader, ChartPanel, ConfirmDialog, Dialog, ErrorState, Field, Input, Legend, LineChart, Menu, MenuContent, MenuItem, MenuTrigger,
  MetricCard, PageHeader, Select, SkeletonRows, useToast,
} from '@/components/ui';
import { CoverageNote, Definition, ROLE_LABEL, RangeSelect, SENTIMENT_LABEL, SimpleTable, SimulatedBanner, fmtDay, fmtWhen, pct } from './shared';
import { MentionList, useInsightAction } from './mentions';
import { SearchForm } from './search-form';
import { AssistantButton } from '@/components/assistant/assistant-panel'; // V3.5 stream E
import type { SentimentResponse, TimelineResponse, TopicsResponse } from './types';

type Detail = SavedSearchDto & { versions: Array<{ version: number; definition: SearchDefinition; created_at: string; created_by: string | null }> };

export function SearchDetail({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const { canOn } = useSession();
  const [params, setParams] = useQueryState();
  const days = Number(params.get('days') ?? 7) || 7;
  const sentiment = params.get('sentiment') ?? '';
  const topic = params.get('topic') ?? '';
  const [text, setText] = useState('');
  const dq = useDebouncedValue(text, 300);
  const s = useApi<Detail>(`/api/listening/searches/${id}`);
  const tl = useApi<TimelineResponse>(`/api/listening/searches/${id}/timeline?days=${days}`, { keepPrevious: true });
  const sen = useApi<SentimentResponse>(`/api/listening/searches/${id}/sentiment?days=${days}`, { keepPrevious: true });
  const top = useApi<TopicsResponse>(`/api/listening/searches/${id}/topics?days=${days}`, { keepPrevious: true });
  const mq = new URLSearchParams({ days: String(days), ...(sentiment ? { sentiment } : {}), ...(topic ? { topic } : {}), ...(dq.trim() ? { text: dq.trim() } : {}) }).toString();
  const ments = useApi<{ items: ObservationDto[]; next_cursor: string | null; coverage: TimelineResponse['coverage'] }>(`/api/listening/searches/${id}/mentions?${mq}`, { keepPrevious: true });
  const [more, setMore] = useState<{ key: string; items: ObservationDto[]; next: string | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const { run } = useInsightAction();
  const refresh = () => { void s.refetch(); void tl.refetch(); void sen.refetch(); void top.refetch(); void ments.refetch(); setMore(null); };

  if (s.error && !s.data) return <ErrorState error={s.error} onRetry={s.refetch} />;
  if (!s.data) return <SkeletonRows rows={6} />;
  const d = s.data;
  const manage = canOn(d.brand_id, 'listening.manage');
  const extra = more?.key === mq ? more : null;
  const items = [...(ments.data?.items ?? []), ...(extra?.items ?? [])];
  const next = extra ? extra.next : ments.data?.next_cursor ?? null;
  const prev = tl.data?.totals.previous ?? null;
  const cur = tl.data?.totals.unique ?? null;
  const delta = cur === null ? null : prev === null ? { state: 'insufficient' as const, pct: null } : prev === 0 ? (cur ? { state: 'new' as const, pct: null } : { state: 'flat' as const, pct: 0 }) : { state: (cur > prev ? 'up' : cur < prev ? 'down' : 'flat') as 'up' | 'down' | 'flat', pct: (cur - prev) / prev };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={<Link href="/listening" className="inline-flex items-center gap-1 hover:text-fg"><ArrowLeft aria-hidden className="size-3.5" />Listening</Link>}
        title={d.name} meta={<>{ROLE_LABEL[d.role]} · query v{d.version}{d.rematch.state !== 'idle' ? ' · updating' : ''}</>}
        actions={<>
          <RangeSelect value={days} onChange={(v) => setParams({ days: v === 7 ? null : String(v) })} />
          <AssistantButton surface="listening" size="md" context={{ type: 'listening_query', id: d.id }} brandId={d.brand_id} />
          {manage ? <Button variant="secondary" icon={<Pencil aria-hidden />} onClick={() => setEditing(true)}>Edit</Button> : null}
          <Menu>
            <MenuTrigger asChild><Button variant="ghost" aria-label="More actions" icon={<Ellipsis aria-hidden />} /></MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={() => run('task', { search_id: d.id })}>Create task</MenuItem>
              <MenuItem onSelect={() => run('draft', { search_id: d.id })}>Create content draft</MenuItem>
              <MenuItem onSelect={() => router.push(`/listening/compare?search_ids=${d.id}`)}>Compare…</MenuItem>
              {manage ? <MenuItem danger onSelect={() => setArchiving(true)}>Archive search</MenuItem> : null}
            </MenuContent>
          </Menu>
        </>} />
      <SimulatedBanner coverage={tl.data?.coverage} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Mentions" value={cur} delta={delta} info={LISTENING_DEFINITIONS.unique} foot={prev === null ? 'No full previous period' : `Previous: ${prev}`} />
        <MetricCard label="Negative" value={sen.data ? pct(sen.data.shares.negative) : null} info={LISTENING_DEFINITIONS.sentiment} foot={sen.data ? `${sen.data.counts.negative} of ${sen.data.scored} scored` : undefined} />
        <MetricCard label="Uncertain" value={sen.data?.uncertain ?? null} info="Low-confidence sentiment (shown with “?”). Managers can correct it." foot={sen.data ? `${sen.data.corrected} corrected` : undefined} />
        <MetricCard label="Repeats collapsed" value={tl.data?.coverage.sample.duplicates_collapsed ?? null} info={tl.data?.coverage.methods.dedupe} foot={tl.data ? `${tl.data.coverage.sample.removed_at_source} removed at source` : undefined} />
      </div>

      {tl.data ? <TimelinePanel tl={tl.data} /> : <Card className="p-4"><SkeletonRows rows={5} /></Card>}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={<span className="inline-flex items-center gap-1">Sentiment<Definition>{LISTENING_DEFINITIONS.sentiment}</Definition></span>} />
          <div className="px-4 pb-4">
            {!sen.data ? <SkeletonRows rows={4} /> : (
              <>
                <BarList label="Sentiment counts" rows={(['positive', 'neutral', 'negative', 'mixed', 'unscored'] as const).map((l) => ({
                  key: l, label: <button type="button" className="hover:underline" onClick={() => setParams({ sentiment: sentiment === l ? null : l })}>{SENTIMENT_LABEL[l]}{sentiment === l ? ' ✓' : ''}</button>, value: sen.data!.counts[l],
                }))} />
                <p className="mt-3 text-xs text-muted">Inferred, not fact · {sen.data.method} · of {sen.data.denominator} unique ({sen.data.scored} scored)</p>
              </>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title={<span className="inline-flex items-center gap-1">Topics<Definition>{LISTENING_DEFINITIONS.topic}</Definition></span>} />
          <div className="px-4 pb-4">
            {!top.data ? <SkeletonRows rows={4} /> : !top.data.topics.length ? <p className="text-[13px] text-muted">Not enough mentions to group yet.</p> : (
              <>
                <BarList label="Topics" rows={top.data.topics.map((t) => ({
                  key: t.label, label: <button type="button" className="hover:underline" onClick={() => setParams({ topic: topic === t.label ? null : t.label })}>{t.label}{topic === t.label ? ' ✓' : ''}</button>, value: t.count,
                  note: undefined,
                }))} />
                <p className="mt-3 text-xs text-muted">Keyword grouping · of {top.data.denominator} unique · groups overlap</p>
              </>
            )}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Mentions" actions={<>
          {sentiment ? <Badge tone="neutral">{SENTIMENT_LABEL[sentiment as keyof typeof SENTIMENT_LABEL]} <button type="button" aria-label="Clear sentiment filter" className="ml-1" onClick={() => setParams({ sentiment: null })}>×</button></Badge> : null}
          {topic ? <Badge tone="neutral">{topic} <button type="button" aria-label="Clear topic filter" className="ml-1" onClick={() => setParams({ topic: null })}>×</button></Badge> : null}
          <label className="relative block w-full sm:w-56">
            <span className="sr-only">Search mentions</span>
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" />
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search text" className="pl-8" />
          </label>
        </>} />
        {ments.data ? <CoverageNote coverage={ments.data.coverage} className="px-4 pb-2" /> : null}
        {ments.error && !ments.data ? <ErrorState error={ments.error} onRetry={ments.refetch} /> : !ments.data ? <SkeletonRows rows={4} className="p-4" /> : (
          <MentionList items={items} onChanged={refresh} hideTopics={[...d.terms, ...d.keywords].flatMap((t) => tokenize(t).map((w) => w.replace(/^[#@]/, '')))} empty={tl.data?.coverage.state === 'not_collected' ? 'Nothing collected for this brand yet' : 'No mentions match'} />
        )}
        {next ? <div className="p-3"><Button variant="ghost" className="w-full" onClick={async () => { const r = await api.get<{ items: ObservationDto[]; next_cursor: string | null }>(`/api/listening/searches/${id}/mentions?${mq}&cursor=${encodeURIComponent(next)}`); setMore({ key: mq, items: [...(extra?.items ?? []), ...r.items], next: r.next_cursor }); }}>Load more</Button></div> : null}
      </Card>

      <AlertRules search={d} manage={manage} />

      <details className="rounded-[var(--radius-card)] border border-border bg-surface px-4 py-3 text-[13px]">
        <summary className="cursor-pointer font-medium">Definition and versions</summary>
        <ul className="mt-3 flex flex-col gap-2">
          {d.versions.map((v) => (
            <li key={v.version} className="text-muted">
              <span className="font-medium text-fg">v{v.version}</span> · {fmtWhen(v.created_at)}{v.created_by ? ` · ${v.created_by}` : ''} — names: {v.definition.terms.join(', ') || '—'}; keywords: {v.definition.keywords.join(', ') || '—'}; exclude: {v.definition.exclusions.join(', ') || '—'}{v.definition.boolean ? `; query: ${v.definition.boolean}` : ''}{v.definition.languages.length ? `; languages: ${v.definition.languages.join(', ')}` : ''}{v.definition.sources.length ? `; sources: ${v.definition.sources.join(', ')}` : ''}
            </li>
          ))}
        </ul>
      </details>

      {editing ? <SearchForm open={editing} onOpenChange={setEditing} search={d} onSaved={() => refresh()} /> : null}
      <ConfirmDialog open={archiving} onOpenChange={setArchiving} title="Archive this search?" confirmLabel="Archive" confirmVariant="danger"
        description="Its alert rules stop. Mentions stay in other searches."
        onConfirm={async () => { await api.del(`/api/listening/searches/${id}`); toast.success('Search archived'); router.push('/listening'); }} />
    </div>
  );
}

function TimelinePanel({ tl }: { tl: TimelineResponse }) {
  const labels = tl.buckets.map((b) => b.at);
  const fmt = (iso: string) => (tl.interval === 'hour' ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : fmtDay(iso));
  const notCollected = tl.buckets.filter((b) => !b.collected).length;
  return (
    <ChartPanel
      title="Mentions over time"
      info="Unique mentions per period. Periods before monitoring began are gaps (not collected), never zero."
      summary={`${tl.totals.unique} unique mentions${notCollected ? `; ${notCollected} periods not collected` : ''}.`}
      chart={<>
        <Legend className="mb-2" items={[{ label: 'Mentions', color: 'var(--chart-1)' }, { label: 'Negative (inferred)', color: 'var(--chart-4)', dash: '6 3' }]} />
        <LineChart ariaLabel="Mentions over time" labels={labels} xLabel={(l) => fmt(l)} series={[
          { key: 'all', label: 'Mentions', color: 'var(--chart-1)', values: tl.buckets.map((b) => b.unique) },
          { key: 'neg', label: 'Negative (inferred)', color: 'var(--chart-4)', dash: '6 3', values: tl.buckets.map((b) => b.negative) },
        ]} />
      </>}
      table={<SimpleTable rows={tl.buckets.map((b) => [fmt(b.at), b.collected ? String(b.unique) : 'Not collected', b.collected ? String(b.negative) : '—'])} head={['Period', 'Mentions', 'Negative']} />}
      footer={<CoverageNote coverage={tl.coverage} />}
    />
  );
}

const WINDOWS = [15, 30, 60, 120, 240, 360, 720, 1440];

function AlertRules({ search, manage }: { search: SavedSearchDto; manage: boolean }) {
  const toast = useToast();
  const rules = useApi<{ items: AlertRuleDto[] }>(`/api/listening/searches/${search.id}/rules`);
  const alerts = useApi<{ items: AlertDto[] }>(`/api/listening/alerts?search_id=${search.id}&limit=5`);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: 'Mention spike', metric: 'volume' as 'volume' | 'negative', window_minutes: 60, min_sample: 10, multiplier: 2, baseline_days: 7, min_baseline_windows: 24, cooldown_minutes: 360 });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.post('/api/listening/rules', { search_id: search.id, ...f }); toast.success('Alert added'); setOpen(false); await rules.refetch(); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const toggle = async (r: AlertRuleDto) => {
    try { await api.patch(`/api/listening/rules/${r.id}`, { enabled: !r.enabled, expected_version: r.version }); await rules.refetch(); } catch (e) { toast.error(e); }
  };
  const num = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: Number(e.target.value) });
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-1">Spike alerts<Definition>{LISTENING_DEFINITIONS.spike}</Definition></span>}
        actions={manage ? <Button size="sm" variant="secondary" icon={<BellPlus aria-hidden />} onClick={() => setOpen(true)}>Add alert</Button> : undefined} />
      <div className="px-4 pb-4">
        {!rules.data ? <SkeletonRows rows={2} /> : !rules.data.items.length ? <p className="text-[13px] text-muted">No alerts for this search.</p> : (
          <ul className="flex flex-col divide-y divide-border">
            {rules.data.items.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">{r.name} {!r.enabled ? <Badge className="ml-1 h-5 px-1.5 text-[11px]">Off</Badge> : null}</p>
                  <p className="text-xs text-muted">{r.metric === 'negative' ? 'Negative mentions' : 'Mentions'} per {r.window_minutes} min · min {r.min_sample} · ×{r.multiplier} and mean + 3σ over {r.baseline_days} d (≥ {r.min_baseline_windows} windows) · cooldown {Math.round(r.cooldown_minutes / 60 * 10) / 10} h</p>
                  {r.last_result ? <p className="text-xs text-subtle">Last check {r.last_evaluated_at ? fmtWhen(r.last_evaluated_at) : ''}: {r.last_result.detail}</p> : null}
                </div>
                {manage ? <Button size="sm" variant="ghost" onClick={() => toggle(r)}>{r.enabled ? 'Turn off' : 'Turn on'}</Button> : null}
              </li>
            ))}
          </ul>
        )}
        {alerts.data?.items.length ? (
          <div className="mt-3 border-t border-border pt-3">
            <p className="mb-1 text-xs font-medium text-subtle">Recent alerts</p>
            <ul className="flex flex-col gap-1">{alerts.data.items.map((a) => <li key={a.id}><Link className="text-[13px] hover:underline" href={`/listening/alerts/${a.id}`}>{fmtWhen(a.created_at)} · {a.observed} in {a.window.minutes} min ({a.state})</Link></li>)}</ul>
          </div>
        ) : null}
      </div>
      <Dialog open={open} onOpenChange={setOpen} title="Add spike alert" busy={busy} footer={<Button variant="primary" onClick={save} disabled={busy || !f.name.trim()}>Add alert</Button>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} /></Field>
          <Field label="Count"><Select value={f.metric} onChange={(e) => setF({ ...f, metric: e.target.value as 'volume' | 'negative' })}><option value="volume">All mentions</option><option value="negative">Negative mentions</option></Select></Field>
          <Field label="Window"><Select value={String(f.window_minutes)} onChange={num('window_minutes')}>{WINDOWS.map((w) => <option key={w} value={w}>{w < 60 ? `${w} min` : `${w / 60} h`}</option>)}</Select></Field>
          <Field label="Minimum sample" hint="Never alert below this count."><Input type="number" min={3} max={10000} value={f.min_sample} onChange={num('min_sample')} /></Field>
          <Field label="Multiplier" hint="× the usual count."><Input type="number" min={1.2} max={20} step={0.1} value={f.multiplier} onChange={num('multiplier')} /></Field>
          <Field label="Baseline days"><Input type="number" min={1} max={28} value={f.baseline_days} onChange={num('baseline_days')} /></Field>
          <Field label="Minimum baseline windows" hint="Monitored windows needed first."><Input type="number" min={3} max={2000} value={f.min_baseline_windows} onChange={num('min_baseline_windows')} /></Field>
          <Field label="Cooldown (minutes)"><Input type="number" min={15} max={10080} value={f.cooldown_minutes} onChange={num('cooldown_minutes')} /></Field>
        </div>
        <p className="mt-4 text-xs text-muted">You’ll be notified. Recipients need listening access when it fires.</p>
      </Dialog>
    </Card>
  );
}
