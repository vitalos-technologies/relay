'use client';
// Publishing operations (V3.1 Admin §8): every destination across brands and networks, filters in the URL, a detail
// drawer with the evidence (schedule zone, approval, authority, attempts, provider ids) and only the recovery actions
// the server says apply. Each action calls the existing service route — the same checks as the main app.
import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, RefreshCw, Search } from 'lucide-react';
import { PROVIDERS, PROVIDER_LABEL, type Provider } from '@social-lite/core';
import type { AdminDeliveryDetail, AdminDeliveryItem, AdminDeliveryList, AdminDeliveryState, RecoveryOption } from '@social-lite/core/contracts/v31-admin';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useQueryState } from '@/lib/client/hooks';
import { useSession } from '@/lib/client/session';
import {
  Badge, Banner, Button, Card, Checkbox, ConfirmDialog, DetailDrawer, Dialog, DrawerSection, EmptyState, ErrorNotice, ErrorState, Facts, Field, FilterBar,
  FilterSelect, Input, PageHeader, PlatformIcon, RadioGroup, SkeletonRows, useToast,
} from '@/components/ui';
import type { Tone } from '@/components/ui/feedback';
import { useAdminTopics } from '@/components/admin/sync';
import { Ago, RecordList } from '@/components/admin/ui';
import { EmergencyPause } from '@/components/shell/emergency-pause';
import { DeliveryBadge } from '@/components/admin/badges';

const QUICK = [['attention', 'Needs attention'], ['queued', 'Queued'], ['processing', 'Processing'], ['awaiting_approval', 'Awaiting approval'], ['scheduled', 'Scheduled'], ['', 'All']] as const;

export default function PublishingOpsPage() {
  const { session } = useSession();
  const [params, setParams] = useQueryState();
  const [q, setQ] = useState(params.get('q') ?? '');
  const keys = ['state', 'provider', 'brand_id', 'window', 'mode', 'q'] as const;
  const query = new URLSearchParams(keys.flatMap((k) => (params.get(k) ? [[k, params.get(k)!]] : [])));
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<AdminDeliveryItem[]>([]);
  const path = `/api/admin/deliveries?${query.toString()}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const { data, error, loading, refetch, refreshing } = useApi<AdminDeliveryList>(path, { keepPrevious: true });
  useEffect(() => { setCursor(null); setPages([]); }, [query.toString()]); // eslint-disable-line react-hooks/exhaustive-deps
  useAdminTopics(['publishing', 'approvals', 'connections'], () => { if (!cursor) void refetch(); });
  const items = useMemo(() => (cursor ? [...pages, ...(data?.items ?? [])] : data?.items ?? []), [cursor, pages, data]);
  const open = params.get('delivery');
  const tz = session.workspace?.timezone ?? 'UTC';

  return (
    <>
      <PageHeader title="Deliveries" meta={data?.counts.attention ? `${data.counts.attention} need attention` : undefined}
        actions={<><Button size="sm" icon={<RefreshCw aria-hidden className="size-4" />} loading={refreshing} onClick={() => void refetch()}>Refresh</Button><div className="w-[220px] max-sm:w-full"><EmergencyPause variant="sidebar" /></div></>} />
      <nav aria-label="Quick filters" className="-mx-1 mb-3 flex gap-1 overflow-x-auto px-1 pb-1">
        {QUICK.map(([k, label]) => {
          const active = (params.get('state') ?? '') === k;
          const n = k && k !== 'scheduled' ? data?.counts[k as keyof AdminDeliveryList['counts']] : undefined;
          return (
            <button key={k || 'all'} type="button" onClick={() => setParams({ state: k || null, delivery: null })} aria-pressed={active}
              className={`touch-target inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium ${active ? 'border-transparent bg-fg text-bg' : 'border-border text-muted hover:text-fg'}`}>
              {label}{n ? <span className="tabular opacity-80">{n}</span> : null}
            </button>
          );
        })}
      </nav>
      <FilterBar>
        <form role="search" className="relative min-w-[180px] flex-1" onSubmit={(e) => { e.preventDefault(); setParams({ q: q.trim() || null }); }}>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <Input aria-label="Search title or destination" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => setParams({ q: q.trim() || null })} className="pl-9" />
        </form>
        <FilterSelect id="f-provider" label="Network" value={params.get('provider') ?? ''} onChange={(v) => setParams({ provider: v || null })}>
          <option value="">All networks</option>{PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
        </FilterSelect>
        <FilterSelect id="f-brand" label="Brand" value={params.get('brand_id') ?? ''} onChange={(v) => setParams({ brand_id: v || null })}>
          <option value="">All brands</option>{session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </FilterSelect>
        <FilterSelect id="f-window" label="Changed" value={params.get('window') ?? ''} onChange={(v) => setParams({ window: v || null })}>
          <option value="">Any time</option><option value="24h">Last 24 h</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option>
        </FilterSelect>
        <FilterSelect id="f-mode" label="Mode" value={params.get('mode') ?? ''} onChange={(v) => setParams({ mode: v || null })}>
          <option value="">Live and simulated</option><option value="live">Live only</option><option value="simulated">Simulated only</option>
        </FilterSelect>
      </FilterBar>
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading && !items.length ? <SkeletonRows rows={6} /> : !items.length ? (
        <EmptyState title="No deliveries match" />
      ) : (
        <Card className="overflow-hidden">
          <RecordList caption="Deliveries" rows={items} rowKey={(d) => d.id} selected={open} onOpen={(d) => setParams({ delivery: d.id })}
            columns={[
              { key: 'dest', label: 'Destination', cell: (d) => <span className="flex min-w-0 items-center gap-2"><PlatformIcon provider={d.provider} size="sm" /><span className="min-w-0 truncate max-w-[220px]">{d.destination}</span></span> },
              { key: 'post', label: 'Post', cell: (d) => <span className="block max-w-[260px] truncate">{d.title || 'Untitled'}</span> },
              { key: 'brand', label: 'Brand', secondary: true, cell: (d) => <span className="text-muted">{d.brand_name}</span> },
              { key: 'state', label: 'State', cell: (d) => <DeliveryBadge d={d} /> },
              { key: 'due', label: 'Due', cell: (d) => <span className="whitespace-nowrap text-muted"><Ago at={d.due_at} /></span> },
              { key: 'err', label: 'Code', secondary: true, cell: (d) => d.error_code ? <code className="text-[12px] text-muted">{d.error_code}</code> : <span className="text-subtle">—</span> },
            ]}
            card={(d) => (
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-2"><PlatformIcon provider={d.provider} size="sm" /><span className="min-w-0 flex-1 truncate font-medium">{d.title || 'Untitled'}</span></span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted"><DeliveryBadge d={d} /><span className="truncate">{d.destination}</span><Ago at={d.due_at} /></span>
              </span>
            )} />
          {data?.next_cursor ? (
            <div className="border-t border-border p-3 text-center">
              <Button size="sm" loading={refreshing} onClick={() => { setPages(items); setCursor(data.next_cursor); }}>Load more</Button>
            </div>
          ) : null}
        </Card>
      )}
      <DeliveryDrawer id={open} tz={tz} onClose={() => setParams({ delivery: null })} onChanged={() => { setCursor(null); setPages([]); void refetch(); }} />
    </>
  );
}

function DeliveryDrawer({ id, tz, onClose, onChanged }: { id: string | null; tz: string; onClose: () => void; onChanged: () => void }) {
  const { data, error, refetch } = useApi<AdminDeliveryDetail>(id ? `/api/admin/deliveries/${id}` : null);
  useAdminTopics(['publishing'], () => { if (id) void refetch(); });
  const toast = useToast();
  const [dialog, setDialog] = useState<RecoveryOption['action'] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const after = async (msg: string) => { toast.success(msg); await refetch(); onChanged(); };
  const run = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    try { await fn(); await after(msg); } catch (e) { toast.error(e, 'Not done'); } finally { setBusy(null); }
  };
  const d = data && data.id === id ? data : null;
  const fmt = (iso: string) => new Date(iso).toLocaleString([], { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
  return (
    <DetailDrawer open={!!id} onOpenChange={(o) => !o && onClose()} wide title={d ? (d.title || 'Untitled') : 'Delivery'}
      meta={d ? <><DeliveryBadge d={d} /><span>{d.brand_name}</span><span className="inline-flex items-center gap-1"><PlatformIcon provider={d.provider} size="xs" decorative />{d.destination}</span>{d.is_mock ? <Badge>Simulated</Badge> : null}</> : null}
      footer={d ? <RecoveryBar d={d} busy={busy} onAction={(a) => {
        if (a === 'retry') void run(a, () => api.post(`/api/deliveries/${d.id}/retry`, {}), 'Retry queued');
        else if (a === 'adopt') void run(a, () => api.post(`/api/schedules/${d.schedule_id}/adopt`, {}), 'Adopted and re-queued');
        else if (a === 'pause_connection' || a === 'resume_connection') void run(a, () => api.post(`/api/connections/${d.connection_id}/pause`, { paused: a === 'pause_connection' }), a === 'pause_connection' ? 'Connection paused' : 'Connection resumed');
        else setDialog(a);
      }} /> : null}>
      {error && !d ? <ErrorState error={error} onRetry={refetch} /> : !d ? <SkeletonRows rows={6} /> : (
        <>
          {d.error_message ? <Banner tone={d.display_state === 'unknown' ? 'warn' : 'danger'} className="mb-4" title={d.error_code ?? 'Error'}>{d.error_message}</Banner> : null}
          <DrawerSection title="Content">
            <p className="text-[13px]">{d.excerpt || '—'}</p>
            <p className="mt-1 text-xs text-muted">Revision {d.revision_number}</p>
          </DrawerSection>
          <DrawerSection title="Schedule">
            <Facts items={[
              ['Requested', `${d.schedule.input_local_time.replace('T', ' ')} (${d.schedule.input_timezone})`],
              ['Executes', `${fmt(d.due_at)} · ${tz}`],
              ['Publish before', fmt(d.schedule.publish_before)],
              ['Schedule', `${d.schedule.status.replace(/_/g, ' ')} · generation ${d.schedule.generation}`],
              ...(d.remote_schedule ? [['Provider release', `${d.remote_schedule.publish_at ? fmt(d.remote_schedule.publish_at) : '—'} · ${d.remote_schedule.state ?? 'scheduled'}`] as [string, string]] : []),
            ]} />
          </DrawerSection>
          <DrawerSection title="Approval and authority">
            <Facts items={[
              ['Approval', d.approval ? (d.approval.required ? `${d.approval.decision ?? 'pending'}${d.approval.decided_by ? ` · ${d.approval.decided_by}` : ''}` : 'Not required') : 'Not required'],
              ['Authority', d.authority ? `${d.authority.status}${d.authority.scheduled_by ? ` · ${d.authority.scheduled_by}` : ''}${d.authority.hold_code ? ` · ${d.authority.hold_code}` : ''}` : '—'],
            ]} />
          </DrawerSection>
          <DrawerSection title="Provider">
            <Facts items={[
              ['IDs', d.provider_ids.length ? <code className="break-all text-[12px]">{d.provider_ids.join(', ')}</code> : '—'],
              ['Link', d.provider_url ? <a href={d.provider_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-text hover:underline">Open<ExternalLink aria-hidden className="size-3" /></a> : '—'],
              ['Reconciliation', d.reconcile.needs_reconcile ? `Checking automatically${d.reconcile.unknown_since ? ` since ${fmt(d.reconcile.unknown_since)}` : ''}` : d.state === 'unknown' ? 'Needs a manual check' : 'Not needed'],
              ['Connection', `${d.connection.status}${d.connection.paused ? ' · paused' : ''}${d.connection.disconnected ? ' · disconnected' : ''}`],
            ]} />
          </DrawerSection>
          <DrawerSection title={`Attempts (${d.attempts.length})`}>
            {!d.attempts.length ? <p className="text-[13px] text-muted">None yet</p> : (
              <ol className="flex flex-col gap-2">
                {d.attempts.map((a) => (
                  <li key={a.attempt_number} className="rounded-lg border border-border px-3 py-2 text-[13px]">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-medium">#{a.attempt_number}</span><span className="text-muted">{a.kind.replace(/_/g, ' ')}</span>
                      {a.outcome ? <Badge tone={a.outcome === 'published' || a.outcome === 'success' ? 'success' : a.outcome === 'requeued' ? 'neutral' : 'warn'}>{a.outcome}</Badge> : null}
                      <span className="ml-auto text-xs text-muted">{fmt(a.started_at)}</span></div>
                    {a.safe_code || a.safe_message ? <p className="mt-1 text-xs text-muted">{a.safe_code ? <code>{a.safe_code}</code> : null} {a.safe_message}</p> : null}
                    {a.actor_email ? <p className="mt-1 text-xs text-subtle">by {a.actor_email}</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </DrawerSection>
          <DrawerSection title="Recovery">
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {d.recovery.map((r) => (
                <li key={r.action} className="flex items-start gap-2"><span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${r.available ? 'bg-success' : 'bg-subtle'}`} aria-hidden />
                  <span><span className="font-medium">{ACTION_LABEL[r.action]}</span>{r.reason ? <span className="text-muted"> — {r.reason}</span> : null}</span></li>
              ))}
            </ul>
          </DrawerSection>
        </>
      )}
      {d ? (
        <>
          <RiskRetryDialog open={dialog === 'retry_with_risk'} onOpenChange={(o) => !o && setDialog(null)} onConfirm={async () => { await api.post(`/api/deliveries/${d.id}/retry`, { acknowledge_duplicate_risk: true }); await after('Retry queued (duplicate risk accepted)'); }} />
          <ResolveDialog open={dialog === 'resolve'} onOpenChange={(o) => !o && setDialog(null)} onConfirm={async (body) => { await api.post(`/api/deliveries/${d.id}/resolve`, body); await after('Resolved'); }} />
          <ConfirmDialog open={dialog === 'cancel'} onOpenChange={(o) => !o && setDialog(null)} title="Cancel this schedule?" confirmLabel="Cancel schedule" confirmVariant="danger"
            description="Cancels every destination of this post that hasn’t started. Destinations already sending can’t be recalled; the result says which."
            onConfirm={async () => { const r = await api.post<{ message?: string }>(`/api/schedules/${d.schedule_id}/cancel`, {}); await after(r.message ?? 'Cancelled'); }} />
          <RescheduleDialog open={dialog === 'reschedule'} onOpenChange={(o) => !o && setDialog(null)} tz={d.schedule.input_timezone}
            onConfirm={async (local, zone) => { await api.post(`/api/schedules/${d.schedule_id}/reschedule`, { input_local_time: local, timezone: zone, expected_generation: d.schedule.generation }, { idempotent: true }); await after('Rescheduled'); }} />
        </>
      ) : null}
    </DetailDrawer>
  );
}

const ACTION_LABEL: Record<RecoveryOption['action'], string> = {
  retry: 'Retry', retry_with_risk: 'Retry (accept duplicate risk)', resolve: 'Resolve manually', cancel: 'Cancel schedule', reschedule: 'Reschedule',
  adopt: 'Adopt', pause_connection: 'Pause connection', resume_connection: 'Resume connection',
};

function RecoveryBar({ d, busy, onAction }: { d: AdminDeliveryDetail; busy: string | null; onAction: (a: RecoveryOption['action']) => void }) {
  const avail = d.recovery.filter((r) => r.available);
  if (!avail.length) return <p className="mr-auto text-xs text-muted">No recovery action applies</p>;
  const primary = avail.find((r) => ['retry', 'resolve', 'adopt'].includes(r.action));
  return (
    <>
      {avail.filter((r) => r !== primary).map((r) => (
        <Button key={r.action} size="sm" variant={r.action === 'cancel' ? 'danger' : 'secondary'} loading={busy === r.action} onClick={() => onAction(r.action)}>{ACTION_LABEL[r.action]}</Button>
      ))}
      {primary ? <Button size="sm" variant="primary" loading={busy === primary.action} onClick={() => onAction(primary.action)}>{ACTION_LABEL[primary.action]}</Button> : null}
    </>
  );
}

function RiskRetryDialog({ open, onOpenChange, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; onConfirm: () => Promise<void> }) {
  const [ack, setAck] = useState(false);
  return (
    <ConfirmDialog open={open} onOpenChange={(o) => { if (!o) setAck(false); onOpenChange(o); }} title="Retry an unknown result?" confirmLabel="Retry" confirmVariant="danger"
      confirmDisabledReason={!ack ? 'Confirm the duplicate risk first' : null} onConfirm={onConfirm}
      description="The last attempt may already be live. Check the channel first; resolving is safer than retrying.">
      <Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)} label="I checked the channel and accept the risk of a duplicate post" />
    </ConfirmDialog>
  );
}

function ResolveDialog({ open, onOpenChange, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; onConfirm: (b: { outcome: 'published' | 'not_published'; provider_url?: string; note?: string }) => Promise<void> }) {
  const [outcome, setOutcome] = useState<'published' | 'not_published'>('published');
  const [url, setUrl] = useState('');
  return (
    <ConfirmDialog open={open} onOpenChange={onOpenChange} title="Resolve after checking the channel" confirmLabel="Save result"
      onConfirm={() => onConfirm({ outcome, ...(outcome === 'published' && url.trim() ? { provider_url: url.trim() } : {}) })}>
      <div className="flex flex-col gap-4">
        <RadioGroup name="outcome" legend="What did you find?" value={outcome} onChange={setOutcome}
          options={[{ value: 'published', label: 'It is live' }, { value: 'not_published', label: 'It is not there' }]} />
        {outcome === 'published' ? <Field label="Post link" optional><Input type="url" inputMode="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} /></Field> : null}
      </div>
    </ConfirmDialog>
  );
}

function RescheduleDialog({ open, onOpenChange, tz, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; tz: string; onConfirm: (local: string, zone: string) => Promise<void> }) {
  const [local, setLocal] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Reschedule" busy={busy}
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" loading={busy} disabledReason={!local ? 'Pick a time' : null} onClick={async () => {
          setBusy(true); setError(null);
          try { await onConfirm(local, tz); onOpenChange(false); } catch (e) { setError(e); } finally { setBusy(false); }
        }}>Reschedule</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label={`New time (${tz})`} hint="Runs the normal checks: approval, brand rules, connection readiness"><Input type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} /></Field>
        {error ? <ErrorNotice error={error} /> : null}
      </div>
    </Dialog>
  );
}
