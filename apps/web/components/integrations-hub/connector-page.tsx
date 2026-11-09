'use client';
// One integration: honest setup state, connect (OAuth / operator / simulated), installations, and for the selected
// installation: status + diagnose, pause/resume, reconnect, disconnect, resources, sync rules, connector settings, history.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Activity, Link2, PauseCircle, PlayCircle, Plug, RefreshCw, Stethoscope, Unplug } from 'lucide-react';
import { slugToConnector, type HubConnector, type InstallationDetailJson } from '@social-lite/core/contracts/v35-integrations';
import type { IntegrationConnectionJson, IntegrationHealthJson } from '@social-lite/core/contracts/v35-connectors';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { fmtRelative } from '@/lib/client/format';
import {
  Badge, Banner, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorState, Facts, FeatureTile, Field, MetaChip, PageHeader, Select, SimulatedBadge, SkeletonRows,
  Tabs, TabsContent, TabsList, TabsTrigger, useToast,
} from '@/components/ui';
import { CONNECTOR_META, STATUS_LABEL } from './meta';
import { stateBadge } from './hub-page';
import { useHub } from './hub-shell';
import { ResourcesPanel } from './resources';
import { SyncRulesPanel } from './sync-rules';
import { HistoryPanel } from './history';
import { ConnectorSettingsPanel, hasConnectorSettings } from './connector-settings';

const ERRORS: Record<string, string> = {
  access_denied: 'Access was not granted.', session_mismatch: 'Finish connecting in the same session you started it from.', invalid_state: 'The sign-in link expired. Try again.',
  forbidden: 'You need integration management rights.', not_configured: 'This integration needs app setup first.', token_exchange_failed: 'The provider did not complete the sign-in.',
  account_mismatch: 'Reconnect with the same account.', authorization_failed: 'The provider refused the sign-in.', session_required: 'Sign in to Relay, then try again.', internal: 'Something went wrong. Try again.',
};

export function ConnectorPage({ slug }: { slug: string }) {
  const connector = slugToConnector(slug);
  const hub = useHub();
  const params = useSearchParams();
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(params.get('connected'));
  useEffect(() => {
    const e = params.get('error');
    if (e) toast.error(ERRORS[e] ?? 'Connecting failed.');
    if (params.get('connected')) toast.success('Connected');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!connector) return <EmptyState title="Unknown integration" />;
  const M = CONNECTOR_META[connector];
  if (hub.error) return <ErrorState error={hub.error} onRetry={hub.refetch} />;
  const c = hub.data?.connectors.find((x) => x.connector === connector);
  if (!c) return <SkeletonRows rows={6} />;
  const live = c.installations.filter((i) => !i.disconnected_at);
  const current = live.find((i) => i.id === selected) ?? live[0] ?? null;
  return (
    <div className="flex max-w-5xl flex-col gap-6" data-testid={`connector-${connector}`}>
      <PageHeader title={<span className="inline-flex items-center gap-3"><FeatureTile><M.icon /></FeatureTile>{M.name}</span>} actions={stateBadge(c)} />
      {!live.length ? <ConnectCard connector={connector} setup={c} canManage={hub.data!.can_manage} onDone={async (id) => { await hub.refetch(); if (id) setSelected(id); }} /> : null}
      {live.length > 1 ? (
        <Field label="Installation" className="max-w-sm">
          <Select value={current?.id ?? ''} onChange={(e) => setSelected(e.target.value)}>
            {live.map((i) => <option key={i.id} value={i.id}>{i.display_name}{i.brand_id ? '' : ' (workspace)'}</option>)}
          </Select>
        </Field>
      ) : null}
      {current ? <InstallationPanel key={current.id} id={current.id} connector={connector} onChanged={hub.refetch} /> : null}
      {live.length ? <ConnectCard connector={connector} setup={c} canManage={hub.data!.can_manage} onDone={async (id) => { await hub.refetch(); if (id) setSelected(id); }} /> : null}
    </div>
  );
}

function ConnectCard({ connector, setup, canManage, onDone }: { connector: HubConnector; setup: NonNullable<ReturnType<typeof useHub>['data']>['connectors'][number]; canManage: boolean; onDone: (id?: string) => Promise<void> }) {
  const toast = useToast();
  const { session, can } = useSession();
  const [scope, setScope] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const operator = connector === 'google_translate';
  const live = setup.installations.filter((i) => !i.disconnected_at);
  const go = async (key: string, fn: () => Promise<unknown>) => { setBusy(key); try { await fn(); } catch (e) { toast.error(e); } finally { setBusy(null); } };
  return (
    <Card aria-labelledby="h-connect">
      <CardHeader id="h-connect" title={live.length ? 'Add another' : 'Connect'} />
      <div className="flex flex-col gap-4 px-4 pb-4">
        {!setup.configured ? (
          <Banner tone="warn" title="Needs app setup">
            {setup.setup_details_visible
              ? <span className="[overflow-wrap:anywhere]">Missing: {setup.missing_settings.join(', ')}. {can('setup.manage') ? <a className="font-medium text-accent-text underline" href="/setup">Open Setup</a> : 'Add them in Setup.'}</span>
              : <span>Ask your Relay admin to set up {setup.name}.</span>}
          </Banner>
        ) : null}
        <Facts items={[
          ['Permissions requested', <span key="s" className="[overflow-wrap:anywhere]">{setup.scopes.length ? setup.scopes.join(', ') : 'Account-wide (no granular scopes)'}</span>],
          ['Before you connect', <ul key="p" className="list-disc pl-4">{setup.prerequisites.map((p) => <li key={p}>{p}</li>)}</ul>],
        ]} />
        <details className="text-[13px]">
          <summary className="cursor-pointer font-medium text-muted hover:text-fg">Setup details</summary>
          <Facts className="mt-3" items={[
            ...(setup.redirect_uri ? [['Redirect URI', <code key="r" className="text-xs [overflow-wrap:anywhere]">{setup.redirect_uri}</code>] as [string, React.ReactNode]] : []),
            ...(setup.webhook_url ? [['Webhook URL', <code key="w" className="text-xs [overflow-wrap:anywhere]">{setup.webhook_url}</code>] as [string, React.ReactNode]] : []),
            ['Docs checked', setup.verified_on],
          ]} />
        </details>
        {canManage ? (
          <div className="flex flex-wrap items-end gap-3">
            {!operator ? (
              <Field label="Scope" className="w-full sm:w-64">
                <Select value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="">Whole workspace</option>
                  {session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Select>
              </Field>
            ) : null}
            <Button variant="primary" icon={<Plug aria-hidden className="size-4" />} loading={busy === 'connect'} disabledReason={!setup.configured ? 'Needs app setup' : null}
              onClick={() => go('connect', async () => {
                if (operator) { const j = await api.post<IntegrationConnectionJson>('/api/connectors/hub/operator', { connector }); toast.success('Connected'); await onDone(j.id); return; }
                const r = await api.post<{ authorization_url: string }>(`/api/connectors/oauth/${connector}/start`, { brand_id: scope || null });
                window.location.assign(r.authorization_url);
              })}>Connect</Button>
            {setup.simulation_available ? (
              <Button variant="secondary" loading={busy === 'sim'} onClick={() => go('sim', async () => {
                const j = await api.post<IntegrationConnectionJson>('/api/connectors/hub/simulated', { connector, brand_id: operator ? null : scope || null });
                toast.success('Simulated integration added'); await onDone(j.id);
              })}>Add simulated</Button>
            ) : null}
          </div>
        ) : <p className="text-[13px] text-muted">People who manage integrations can connect this.</p>}
      </div>
    </Card>
  );
}

function InstallationPanel({ id, connector, onChanged }: { id: string; connector: HubConnector; onChanged: () => Promise<unknown> }) {
  const toast = useToast();
  const detail = useApi<InstallationDetailJson>(`/api/connectors/hub/${id}`);
  const health = useApi<IntegrationHealthJson>(`/api/connectors/${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [tab, setTab] = useState('resources');
  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.refetch} />;
  if (!detail.data) return <SkeletonRows rows={5} />;
  const i = detail.data.integration;
  const manage = detail.data.can_manage;
  const st = STATUS_LABEL[i.status] ?? { label: i.status, tone: 'neutral' as const };
  const refresh = async () => { await Promise.all([detail.refetch(), health.refetch(), onChanged()]); };
  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => { setBusy(key); try { await fn(); if (ok) toast.success(ok); await refresh(); } catch (e) { toast.error(e); } finally { setBusy(null); } };
  const rl = i.rate_limit;
  return (
    <>
      <Card aria-labelledby="h-inst" data-testid="installation">
        <CardHeader id="h-inst" title={<span className="flex flex-wrap items-center gap-2">{i.display_name}{i.is_simulated && i.status === 'active' ? null : <Badge tone={st.tone}>{st.label}</Badge>}{i.is_simulated && !/simulated/i.test(i.display_name) ? <SimulatedBadge /> : null}<MetaChip>{i.brand_id ? 'Brand' : 'Workspace'}</MetaChip></span>}
          actions={manage ? <>
            <Button size="sm" variant="ghost" icon={<Stethoscope aria-hidden className="size-4" />} loading={busy === 'diag'} onClick={() => run('diag', async () => { const r = await api.post<{ message: string }>(`/api/connectors/hub/${id}/diagnose`); toast.info(r.message); })}>Diagnose</Button>
            {i.status === 'reconnect_required' && !i.is_simulated ? (
              <Button size="sm" variant="primary" icon={<RefreshCw aria-hidden className="size-4" />} loading={busy === 'rc'} onClick={() => run('rc', async () => {
                const r = await api.post<{ authorization_url: string }>(`/api/connectors/oauth/${connector}/start`, { brand_id: i.brand_id, reconnect_id: i.id }); window.location.assign(r.authorization_url);
              })}>Reconnect</Button>
            ) : null}
            <Button size="sm" variant="ghost" icon={i.paused ? <PlayCircle aria-hidden className="size-4" /> : <PauseCircle aria-hidden className="size-4" />} loading={busy === 'pause'}
              onClick={() => run('pause', () => api.patch(`/api/connectors/${id}`, { paused: !i.paused }), i.paused ? 'Resumed' : 'Paused')}>{i.paused ? 'Resume' : 'Pause'}</Button>
            <Button size="sm" variant="ghost" icon={<Unplug aria-hidden className="size-4" />} onClick={() => setConfirm(true)}>Disconnect</Button>
          </> : undefined} />
        <div className="grid grid-cols-1 gap-4 px-4 pb-4 md:grid-cols-2">
          <Facts items={[
            ['Health', <span key="h">{i.health.message || '—'}{i.health.checked_at ? <span className="text-subtle"> · {fmtRelative(i.health.checked_at)}</span> : null}</span>],
            ['Last sync', i.last_success_at ? fmtRelative(i.last_success_at) : 'Never'],
            ['Last error', i.last_error ? `${i.last_error.code ?? 'error'} · ${fmtRelative(i.last_error.at)}` : 'None'],
          ]} />
          <Facts items={[
            ['Granted', i.granted_scopes.length ? <span key="g" className="[overflow-wrap:anywhere]">{i.granted_scopes.join(', ')}</span> : '—'],
            ['Missing', i.missing_scopes.length ? <span key="m" className="text-warn [overflow-wrap:anywhere]">{i.missing_scopes.join(', ')}</span> : 'None'],
            ['Rate limit', rl ? `${rl.remaining ?? '?'}${rl.limit ? ` of ${rl.limit}` : ''} left${rl.reset_at ? ` · resets ${fmtRelative(rl.reset_at)}` : ''} (${rl.source})` : 'Not reported by the provider'],
          ]} />
          {health.data ? (
            <p className="text-xs text-muted md:col-span-2"><Activity aria-hidden className="mr-1 inline size-3.5" />
              {health.data.jobs.queued} queued · {health.data.jobs.failed_24h} failed (24 h) · {health.data.jobs.unknown} not confirmed · {health.data.events.pending} inbound pending
              {health.data.events.last_received_at ? ` · last event ${fmtRelative(health.data.events.last_received_at)}` : ''}</p>
          ) : null}
          {i.paused ? <Banner tone="info" className="md:col-span-2" title="Paused">Nothing is sent or synced until you resume.</Banner> : null}
          {i.status === 'reconnect_required' ? <Banner tone="danger" className="md:col-span-2" title="Access was revoked">Relay records are kept; links are marked unavailable until you reconnect.</Banner> : null}
        </div>
      </Card>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList label="Installation sections">
          <TabsTrigger value="resources">Resources</TabsTrigger>
          <TabsTrigger value="sync">Sync rules</TabsTrigger>
          {hasConnectorSettings(connector) ? <TabsTrigger value="settings">Settings</TabsTrigger> : null}
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="resources"><ResourcesPanel integration={i} connector={connector} canManage={manage} /></TabsContent>
        <TabsContent value="sync"><SyncRulesPanel integration={i} connector={connector} canManage={manage} /></TabsContent>
        {hasConnectorSettings(connector) ? <TabsContent value="settings"><ConnectorSettingsPanel integration={i} connector={connector} canManage={manage} /></TabsContent> : null}
        <TabsContent value="history"><HistoryPanel integrationId={id} health={health.data ?? null} /></TabsContent>
      </Tabs>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Disconnect ${i.display_name}?`} confirmLabel="Disconnect" confirmVariant="danger"
        description="Relay deletes its credentials and revokes access where the provider allows it. Linked records stay in Relay and show as unavailable."
        onConfirm={async () => { await api.del(`/api/connectors/hub/${id}`); toast.success('Disconnected'); await onChanged(); }}>
        <p className="flex items-center gap-2 text-[13px] text-muted"><Link2 aria-hidden className="size-4" />External tasks, tickets and campaigns are not deleted.</p>
      </ConfirmDialog>
    </>
  );
}
