'use client';
// Connection administration (V3.1 Admin §9): every social account across brands with auth health, token expiry, last
// publication, last analytics sync, affected scheduled work and the recommended fix (from the health centre). Customer
// account authorization (here) is kept apart from Relay's provider app configuration (instance setup, read-only here).
// Diagnostics are read-only; nothing on this page publishes.
import { useState } from 'react';
import { Pause, Play, RefreshCw, Search, Stethoscope } from 'lucide-react';
import { PROVIDERS, PROVIDER_LABEL, type Provider } from '@social-lite/core';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useQueryState } from '@/lib/client/hooks';
import { useSession } from '@/lib/client/session';
import { useFlag } from '@/lib/client/flags';
import {
  Badge, Banner, Button, Card, DetailDrawer, DrawerSection, EmptyState, ErrorState, Facts, FilterBar, FilterSelect, Input, PageHeader, PlatformIcon, SkeletonRows, useToast,
} from '@/components/ui';
import { DiagnosticsDrawer } from '@/components/integrations/diagnostics';
import { useAdminTopics } from '@/components/admin/sync';
import { Ago, RecordList } from '@/components/admin/ui';
import type { AdminConnection } from '@social-lite/services/admin/reads';

interface Fix { action: string; label: string; how: string; allowed: boolean; who: string | null }
interface Health { items: Array<{ connection: { id: string }; state: 'ok' | 'warning' | 'critical'; issues: Array<{ code: string; severity: string; title: string; detail: string; fix: Fix }>; affected: { count: number } }> }
interface ProviderStatus { provider: Provider; configured: boolean; missing: string[] }

const STATE_TONE = { ok: 'success', warning: 'warn', critical: 'danger' } as const;

export default function AdminConnectionsPage() {
  const [params, setParams] = useQueryState();
  const [q, setQ] = useState(params.get('q') ?? '');
  const { session } = useSession();
  const list = useApi<{ items: AdminConnection[] }>('/api/admin/connections');
  const health = useApi<Health>('/api/accounts/health');
  const providers = useApi<{ items: ProviderStatus[] }>('/api/providers');
  useAdminTopics(['connections', 'publishing', 'jobs'], () => { void list.refetch(); void health.refetch(); });
  const byId = new Map((health.data?.items ?? []).map((h) => [h.connection.id, h]));
  const problem = params.get('problem') === '1';
  const provider = params.get('provider') ?? '';
  const brand = params.get('brand_id') ?? '';
  const term = (params.get('q') ?? '').toLowerCase();
  const rows = (list.data?.items ?? []).filter((c) => (!problem || (byId.get(c.id)?.state ?? 'ok') !== 'ok' || c.status !== 'ready')
    && (!provider || c.provider === provider) && (!brand || c.brand_id === brand) && (!term || `${c.display_name} ${c.username ?? ''} ${c.brand_name}`.toLowerCase().includes(term)));
  const open = list.data?.items.find((c) => c.id === params.get('connection')) ?? null;
  const counts = { critical: health.data?.items.filter((h) => h.state === 'critical').length ?? 0, warning: health.data?.items.filter((h) => h.state === 'warning').length ?? 0 };

  return (
    <>
      <PageHeader title="Social accounts" meta={list.data ? `${list.data.items.length} accounts` : undefined}
        actions={<Button size="sm" icon={<RefreshCw aria-hidden className="size-4" />} loading={list.refreshing} onClick={() => { void list.refetch(); void health.refetch(); }}>Refresh</Button>} />
      {counts.critical || counts.warning ? (
        <Banner tone={counts.critical ? 'danger' : 'warn'} className="mb-4" title={`${counts.critical ? `${counts.critical} can’t publish` : ''}${counts.critical && counts.warning ? ' · ' : ''}${counts.warning ? `${counts.warning} need attention soon` : ''}`}
          actions={!problem ? <Button size="sm" onClick={() => setParams({ problem: '1' })}>Show</Button> : null} />
      ) : null}
      <FilterBar>
        <form role="search" className="relative min-w-[180px] flex-1" onSubmit={(e) => { e.preventDefault(); setParams({ q: q.trim() || null }); }}>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <Input aria-label="Search accounts" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => setParams({ q: q.trim() || null })} className="pl-9" />
        </form>
        <FilterSelect id="c-provider" label="Network" value={provider} onChange={(v) => setParams({ provider: v || null })}>
          <option value="">All networks</option>{PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
        </FilterSelect>
        <FilterSelect id="c-brand" label="Brand" value={brand} onChange={(v) => setParams({ brand_id: v || null })}>
          <option value="">All brands</option>{session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </FilterSelect>
        <FilterSelect id="c-problem" label="Health" value={problem ? '1' : ''} onChange={(v) => setParams({ problem: v || null })}>
          <option value="">Any health</option><option value="1">Needs attention</option>
        </FilterSelect>
      </FilterBar>
      {list.error && !list.data ? <ErrorState error={list.error} onRetry={list.refetch} /> : list.loading ? <SkeletonRows rows={6} /> : !rows.length ? <EmptyState title="No accounts match" /> : (
        <Card className="overflow-hidden">
          <RecordList caption="Social accounts" rows={rows} rowKey={(c) => c.id} selected={open?.id} onOpen={(c) => setParams({ connection: c.id })}
            columns={[
              { key: 'acct', label: 'Account', cell: (c) => <span className="flex min-w-0 items-center gap-2"><PlatformIcon provider={c.provider} size="sm" /><span className="min-w-0"><span className="block max-w-[220px] truncate font-medium">{c.display_name}</span><span className="block truncate text-xs text-muted">{c.brand_name}</span></span></span> },
              { key: 'health', label: 'Health', cell: (c) => <HealthChip c={c} h={byId.get(c.id)} /> },
              { key: 'token', label: 'Token expires', secondary: true, cell: (c) => <Ago at={c.token_expires_at} className="text-muted" /> },
              { key: 'pub', label: 'Last published', cell: (c) => <Ago at={c.last_published_at} className="text-muted" /> },
              { key: 'sync', label: 'Last sync', secondary: true, cell: (c) => <Ago at={c.last_sync_ok_at} className="text-muted" /> },
              { key: 'up', label: 'Upcoming', cell: (c) => <span className="tabular">{c.upcoming}</span> },
            ]}
            card={(c) => (
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-2"><PlatformIcon provider={c.provider} size="sm" /><span className="min-w-0 flex-1 truncate font-medium">{c.display_name}</span></span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted"><HealthChip c={c} h={byId.get(c.id)} /><span className="truncate">{c.brand_name}</span><span>{c.upcoming} upcoming</span></span>
              </span>
            )} />
        </Card>
      )}
      <ConnectionDrawer c={open} h={open ? byId.get(open.id) : undefined} app={providers.data?.items.find((p) => p.provider === open?.provider)}
        onClose={() => setParams({ connection: null })} onChanged={() => { void list.refetch(); void health.refetch(); }} />
    </>
  );
}

function HealthChip({ c, h }: { c: AdminConnection; h?: Health['items'][number] }) {
  const state = c.status === 'disconnected' ? 'critical' : h?.state ?? 'ok';
  const label = c.status === 'disconnected' ? 'Disconnected' : c.paused ? 'Paused' : h?.issues[0]?.title ?? 'Connected';
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={c.paused && state === 'ok' ? 'neutral' : STATE_TONE[state]}>{label}</Badge>
      {c.simulated ? <Badge>Simulated</Badge> : null}
    </span>
  );
}

function ConnectionDrawer({ c, h, app, onClose, onChanged }: { c: AdminConnection | null; h?: Health['items'][number]; app?: ProviderStatus; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const { canOn } = useSession();
  const diagOn = useFlag('v31.integration_diagnostics');
  const [diag, setDiag] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  if (!c) return <DetailDrawer open={false} onOpenChange={() => onClose()} title="Account">{null}</DetailDrawer>;
  const manage = canOn(c.brand_id, 'connections.manage');
  const run = async (k: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(k);
    try { await fn(); toast.success(msg); onChanged(); } catch (e) { toast.error(e, 'Not done'); } finally { setBusy(null); }
  };
  const reconnect = () => run('reconnect', async () => {
    if (c.provider === 'telegram' && !c.simulated) { window.location.assign(`/accounts?brand=${c.brand_id}`); return; }
    const r = await api.post<{ authorization_url?: string }>(`/api/connections/${c.id}/reconnect`, {});
    if (r?.authorization_url) window.location.assign(r.authorization_url);
  }, 'Reconnect started');
  return (
    <DetailDrawer open onOpenChange={(o) => !o && onClose()} wide title={c.display_name}
      meta={<><PlatformIcon provider={c.provider} size="xs" decorative />{PROVIDER_LABEL[c.provider]}<span>{c.brand_name}</span>{c.simulated ? <Badge>Simulated</Badge> : null}</>}
      footer={<>
        {diagOn ? <Button size="sm" icon={<Stethoscope aria-hidden className="size-4" />} onClick={() => setDiag(true)}>Diagnostics</Button> : null}
        <Button size="sm" icon={c.paused ? <Play aria-hidden className="size-4" /> : <Pause aria-hidden className="size-4" />} loading={busy === 'pause'}
          disabledReason={!manage ? 'Needs Manage connections on this brand' : c.status === 'disconnected' ? 'Disconnected' : null}
          onClick={() => run('pause', () => api.post(`/api/connections/${c.id}/pause`, { paused: !c.paused }), c.paused ? 'Resumed' : 'Paused')}>{c.paused ? 'Resume' : 'Pause'}</Button>
        <Button size="sm" variant="primary" loading={busy === 'reconnect'} disabledReason={!manage ? 'Needs Manage connections on this brand' : null} onClick={() => void reconnect()}>Reconnect</Button>
      </>}>
      {h?.issues.length ? (
        <DrawerSection title="Recommended fix">
          <ul className="flex flex-col gap-3">
            {h.issues.map((i) => (
              <li key={i.code} className="text-[13px]">
                <p className="font-medium">{i.title} <Badge tone={i.severity === 'critical' ? 'danger' : i.severity === 'warning' ? 'warn' : 'neutral'}>{i.severity}</Badge></p>
                <p className="mt-0.5 text-muted">{i.detail}</p>
                <p className="mt-1">{i.fix.how}{!i.fix.allowed && i.fix.who ? <span className="text-muted"> · {i.fix.who}</span> : null}</p>
              </li>
            ))}
          </ul>
        </DrawerSection>
      ) : null}
      <DrawerSection title="Authorization">
        <Facts items={[
          ['Account', c.username ? `@${c.username}` : c.display_name],
          ['Status', `${c.status.replace(/_/g, ' ')}${c.paused ? ' · paused' : ''}`],
          ['Token expires', c.token_expires_at ? new Date(c.token_expires_at).toLocaleString() : c.simulated ? 'Simulated' : 'Not reported'],
          ['Refresh until', c.refresh_expires_at ? new Date(c.refresh_expires_at).toLocaleString() : '—'],
          ['Granted scopes', c.scopes ?? 'Not observable'],
          ['Throttled until', c.throttled_until ? new Date(c.throttled_until).toLocaleString() : '—'],
          ['Last checked', <Ago key="ck" at={c.checked_at} />],
        ]} />
      </DrawerSection>
      <DrawerSection title="Activity">
        <Facts items={[
          ['Last published', <Ago key="p" at={c.last_published_at} />],
          ['Last analytics sync', <Ago key="s" at={c.last_sync_ok_at} />],
          ['Last sync failure', c.last_sync_failed ? <span key="f"><Ago at={c.last_sync_failed.at} />{c.last_sync_failed.code ? <code className="ml-1 text-[12px]">{c.last_sync_failed.code}</code> : null}</span> : '—'],
          ['Upcoming scheduled', `${c.upcoming}${h?.affected.count ? ` · ${h.affected.count} at risk` : ''}`],
          ['Capabilities', c.capabilities.length ? c.capabilities.join(', ').replace(/_/g, ' ') : '—'],
        ]} />
      </DrawerSection>
      <DrawerSection title="Relay app for this network">
        <p className="text-[13px]">{app ? (app.configured ? 'Configured on this installation' : `Not configured (${app.missing.join(', ')})`) : '—'}</p>
      </DrawerSection>
      {diagOn ? <DiagnosticsDrawer connectionId={c.id} open={diag} onOpenChange={setDiag} /> : null}
    </DetailDrawer>
  );
}
