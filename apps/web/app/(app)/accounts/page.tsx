'use client';
// V3 Connections: per-brand connected accounts with one capability state each (spec §6), publishing formats and
// analytics shown independently, a "Connect a network" picker for all ten networks (Bluesky = handle + app password),
// and the workspace's content sources (Content Hub components).
import { useCallback, useEffect, useState } from 'react';
import { ChartColumn, Ellipsis, FlaskConical, HeartPulse, Pause, Play, Plug, Plus, RefreshCw, Stethoscope, Unplug } from 'lucide-react';
import { useFlag } from '@/lib/client/flags';
import { DiagnosticsDrawer } from '@/components/integrations/diagnostics';
import { PROVIDERS, PROVIDER_LABEL, type ChannelCapabilities, type Provider } from '@social-lite/core';
import { api, isApiError } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { useBrandFilter, useQueryState } from '@/lib/client/hooks';
import { connectionFix } from '@/lib/client/connection-fix';
import { capabilityState, formatLabels, NO_APP_SETUP } from '@/lib/client/capability-state';
import { CapabilityBadge } from '@/components/accounts/capability-badge';
import { fmtRelative, plural } from '@/lib/client/format';
import type { Connection, MockScenario, ProviderStatus, SessionBrand } from '@/lib/client/types';
import {
  Banner, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, IconButton, IntegrationCard, LinkButton, Menu, MenuContent, MenuItem,
  MenuLabel, MenuSeparator, MenuTrigger, PageHeader, PlatformIcon, SectionHeader, Select, SimulatedBadge, SkeletonRows, TimeWithZone, useToast, cn,
} from '@/components/ui';
import { BlueskyDialog, MOCK_SCENARIOS, MOCK_SCENARIO_LABEL, MockDialog, NotConfiguredDialog, TelegramDialog } from '@/components/accounts/connect-dialogs';
import dynamic from 'next/dynamic';
// Content sources (Google/Notion) render below the social accounts; their code loads after the page.
const SourceConnectionsSettings = dynamic(() => import('@/components/content-hub/source-connections').then((m) => m.SourceConnectionsSettings));

const CALLBACK_ERRORS: Record<string, string> = {
  access_denied: 'Cancelled. Nothing was connected.',
  invalid_state: 'Link expired. Start again.',
  state_mismatch: 'Link expired. Start again.',
  no_destinations: 'No pages or profiles to publish to.',
  provider_error: 'Network error. Try again shortly.',
  provider_not_configured: 'Network not set up. See Setup.',
  session_required: 'Session ended. Sign in and retry.',
  session_mismatch: 'Started by another user. Start again.',
  authorization_failed: 'Authorisation incomplete. Start again.',
  token_exchange_failed: 'Access not confirmed. Try again shortly.',
  destinations_failed: 'Couldn’t list pages. Try again shortly.',
  invalid_provider: 'Network not supported.',
  forbidden: 'No permission for this brand.',
};

export default function ConnectionsPage() {
  const { session, can, canV2 } = useSession();
  const [brand] = useBrandFilter();
  const diagOn = useFlag('v31.integration_diagnostics');
  const [params, setParams] = useQueryState();
  const providers = useApi<{ items: ProviderStatus[] }>('/api/providers');
  const brands = brand ? session.brands.filter((b) => b.id === brand) : session.brands;
  const err = params.get('error');
  const connected = params.get('connected');
  const [settled, setSettled] = useState<Set<string>>(() => new Set());
  const markSettled = useCallback((id: string) => setSettled((s) => (s.has(id) ? s : new Set(s).add(id))), []);

  return (
    <>
      <PageHeader title="Connections" actions={<>
        {diagOn ? <LinkButton href={brand ? `/accounts/diagnostics?brand=${brand}` : '/accounts/diagnostics'} variant="ghost" icon={<Stethoscope aria-hidden className="size-4" />}>Test centre</LinkButton> : null}
        <LinkButton href={brand ? `/accounts/health?brand=${brand}` : '/accounts/health'} icon={<HeartPulse aria-hidden className="size-4" />}>Health</LinkButton>
      </>} />
      {err ? (
        <Banner tone="danger" role="alert" className="mb-6" title="Couldn’t connect" actions={<Button size="sm" variant="ghost" onClick={() => setParams({ error: null })}>Dismiss</Button>}>
          {CALLBACK_ERRORS[err] ?? 'Something went wrong.'} <span className="font-mono text-[11px] text-subtle">({err})</span>
        </Banner>
      ) : null}
      {connected ? (
        <Banner tone="success" role="status" className="mb-6" title={`${plural(Number(connected) || 0, 'destination')} connected`} actions={<Button size="sm" variant="ghost" onClick={() => setParams({ connected: null })}>Dismiss</Button>} />
      ) : null}
      {!can('connections.manage') ? <Banner tone="info" className="mb-6" title="View only" /> : null}
      {!brands.length ? (
        <EmptyState icon={<Plug aria-hidden />} title="No brands yet" />
      ) : (
        <>
          {/* Sections load in parallel; show them together so a finished brand never pushes the others down (CLS). */}
          {settled.size < brands.length ? <SkeletonRows rows={4} /> : null}
          <div className={settled.size < brands.length ? 'hidden' : 'flex flex-col gap-10'}>
            {brands.map((b) => <BrandConnections key={b.id} brand={b} providers={providers.data?.items ?? []} showHeading={brands.length > 1} onSettled={markSettled} />)}
          </div>
        </>
      )}
      {/* The Content Hub component reads ?connected/?error itself; hide it while a social callback banner is showing. */}
      {canV2('connections.read') && !err && !connected && settled.size >= brands.length ? (
        <section aria-labelledby="h-sources" className="mt-12 border-t border-border pt-8">
          <SectionHeader id="h-sources" title="Content sources" />
          <SourceConnectionsSettings />
        </section>
      ) : null}
    </>
  );
}

function BrandConnections({ brand, providers, showHeading, onSettled }: { brand: SessionBrand; providers: ProviderStatus[]; showHeading: boolean; onSettled: (brandId: string) => void }) {
  const { session, can } = useSession();
  const toast = useToast();
  const { data, error, loading, refetch, setData } = useApi<{ items: Connection[] }>(`/api/brands/${brand.id}/connections`, {
    poll: (d) => (d?.items.some((c) => c.status === 'pending_verification') ? 5_000 : false),
  });
  useEffect(() => { if (data || error) onSettled(brand.id); }, [data, error, brand.id, onSettled]);
  const [tg, setTg] = useState<{ reconnect: Connection | null } | null>(null);
  const [bsky, setBsky] = useState<{ reconnect: Connection | null } | null>(null);
  const [mockOpen, setMockOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notConfigured, setNotConfigured] = useState<Provider | null>(null);
  const [starting, setStarting] = useState<Provider | null>(null);
  const manage = can('connections.manage');
  const status = (p: Provider) => providers.find((x) => x.provider === p);
  const configured = (p: Provider) => NO_APP_SETUP.includes(p) || status(p)?.configured !== false;

  const upsert = (c: Connection) => setData((d) => ({ items: d?.items.some((x) => x.id === c.id) ? d.items.map((x) => (x.id === c.id ? c : x)) : [...(d?.items ?? []), c] }));

  const connect = async (p: Provider) => {
    setPickerOpen(false);
    if (p === 'telegram') return setTg({ reconnect: null });
    if (p === 'bluesky') return setBsky({ reconnect: null });
    if (!configured(p)) return setNotConfigured(p);
    setStarting(p);
    try {
      const r = await api.post<{ authorization_url: string }>(`/api/brands/${brand.id}/connections/${p}/start`, {});
      window.location.assign(r.authorization_url);
    } catch (e) {
      setStarting(null);
      if (isApiError(e) && e.code === 'provider_not_configured') setNotConfigured(p);
      else toast.error(e, `Couldn’t start connecting ${PROVIDER_LABEL[p]}`);
    }
  };

  const items = (data?.items ?? []).slice().sort((a, b) => Number(a.status === 'disconnected') - Number(b.status === 'disconnected') || PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider));
  // Simulated status is shown once (shell); per-card provenance only when real and simulated accounts mix.
  const mixed = items.some((c) => c.is_mock) && items.some((c) => !c.is_mock);
  const counts = new Map<Provider, number>();
  for (const c of items) if (c.status !== 'disconnected') counts.set(c.provider, (counts.get(c.provider) ?? 0) + 1);

  return (
    <section aria-labelledby={`b-${brand.id}`}>
      <SectionHeader
        id={`b-${brand.id}`}
        title={showHeading ? <>{brand.name}{brand.publishing_paused ? <span className="text-xs font-normal text-warn">Paused</span> : null}</> : <span className="sr-only">{brand.name}</span>}
        count={showHeading ? items.filter((c) => c.status !== 'disconnected').length : null}
        actions={manage ? (
          <Button variant="primary" icon={<Plus aria-hidden className="size-4" />} loading={!!starting} onClick={() => setPickerOpen(true)}>
            {starting ? `Opening ${PROVIDER_LABEL[starting]}…` : 'Connect'}<span className="sr-only"> a network to {brand.name}</span>
          </Button>
        ) : null}
      />

      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows rows={2} /> : !items.length ? (
        manage ? <NetworkGrid counts={counts} configured={configured} onPick={(p) => void connect(p)} /> : <EmptyState icon={<Plug aria-hidden />} title="No accounts yet" compact />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((c) => (
            <ConnectionCard
              key={c.id}
              c={c}
              mixed={mixed}
              manage={manage}
              onChanged={upsert}
              onReconnectCredential={() => (c.provider === 'bluesky' ? setBsky({ reconnect: c }) : setTg({ reconnect: c }))}
              onNotConfigured={() => setNotConfigured(c.provider)}
            />
          ))}
        </ul>
      )}

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen} size="lg" title={`Connect a network to ${brand.name}`}>
        <NetworkGrid counts={counts} configured={configured} onPick={(p) => void connect(p)} />
        {session.mock_providers_enabled ? (
          <div className="mt-4 border-t border-border pt-4">
            <Button variant="ghost" icon={<FlaskConical aria-hidden className="size-4" />} onClick={() => { setPickerOpen(false); setMockOpen(true); }}>Simulated destination</Button>
          </div>
        ) : null}
      </Dialog>
      <TelegramDialog open={!!tg} onOpenChange={(o) => !o && setTg(null)} brandId={brand.id} reconnect={tg?.reconnect} onDone={(c) => { upsert(c); toast.success(c.status === 'ready' ? 'Telegram channel ready' : `Connected — ${c.status_label}`, connectionFix(c) ?? undefined); }} />
      <BlueskyDialog open={!!bsky} onOpenChange={(o) => !o && setBsky(null)} brandId={brand.id} reconnect={bsky?.reconnect} onDone={(c) => { upsert(c); toast.success(c.status === 'ready' ? 'Bluesky connected' : `Connected — ${c.status_label}`, connectionFix(c) ?? undefined); }} />
      <MockDialog open={mockOpen} onOpenChange={setMockOpen} brandId={brand.id} onDone={(c) => { upsert(c); toast.success('Simulated destination added'); }} />
      <NotConfiguredDialog provider={notConfigured} status={notConfigured ? status(notConfigured) : undefined} open={!!notConfigured} onOpenChange={(o) => !o && setNotConfigured(null)} />
    </section>
  );
}

/** All ten networks: Available to connect / Not set up, with how many are already connected. */
function NetworkGrid({ counts, configured, onPick }: { counts: Map<Provider, number>; configured: (p: Provider) => boolean; onPick: (p: Provider) => void }) {
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" aria-label="Networks">
      {PROVIDERS.map((p) => {
        const n = counts.get(p) ?? 0;
        const ok = configured(p);
        return (
          <li key={p}>
            <button
              type="button"
              onClick={() => onPick(p)}
              className="flex h-full w-full flex-col items-start gap-2 rounded-xl border border-border bg-surface p-3 text-left transition-colors hover:border-border-strong hover:bg-raised/50"
            >
              <PlatformIcon provider={p} size="md" decorative />
              <span className="text-[13px] font-medium">{PROVIDER_LABEL[p]}</span>
              <span className={cn('text-[11px]', ok ? 'text-muted' : 'text-subtle')}>
                {!ok ? 'Not set up' : n ? `${n} connected · add more` : 'Available to connect'}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ConnectionCard({
  c, mixed, manage, onChanged, onReconnectCredential, onNotConfigured,
}: { c: Connection; mixed: boolean; manage: boolean; onChanged: (c: Connection) => void; onReconnectCredential: () => void; onNotConfigured: () => void }) {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [simOpen, setSimOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const diagOn = useFlag('v31.integration_diagnostics');
  const state = capabilityState(c);
  const caps = c.capabilities as Partial<ChannelCapabilities>;
  const formats = formatLabels(c);
  const fix = connectionFix(c);
  const disconnected = c.status === 'disconnected';
  const note = (state === 'paused' ? null : fix) ?? (caps.eligibility && caps.eligibility.status !== 'eligible' ? caps.eligibility.message : null) ?? (c.status !== 'ready' && c.health?.message ? c.health.message : null);

  const check = async () => {
    setChecking(true);
    try {
      const r = await api.post<Connection>(`/api/connections/${c.id}/check`, {});
      onChanged(r);
      toast.info(`${r.display_name}: ${r.status_label}`, r.health?.message ?? undefined);
    } catch (e) {
      toast.error(e, 'Check failed');
    } finally {
      setChecking(false);
    }
  };
  const reconnect = async () => {
    if ((c.provider === 'telegram' || c.provider === 'bluesky') && !c.is_mock) return onReconnectCredential();
    try {
      const r = await api.post<Connection | { authorization_url: string }>(`/api/connections/${c.id}/reconnect`, {});
      if ('authorization_url' in r && r.authorization_url) window.location.assign(r.authorization_url);
      else onChanged(r as Connection);
    } catch (e) {
      if (isApiError(e) && e.code === 'provider_not_configured') onNotConfigured();
      else toast.error(e, 'Couldn’t start reconnecting');
    }
  };
  const setScenario = async (s: MockScenario) => {
    try {
      onChanged(await api.patch<Connection>(`/api/connections/${c.id}/mock-scenario`, { scenario: s }));
      toast.success('Simulated behaviour updated', MOCK_SCENARIO_LABEL[s]);
    } catch (e) {
      toast.error(e, 'Couldn’t change the scenario');
    }
  };

  return (
    <IntegrationCard
      as="li"
      className={cn(disconnected && 'opacity-70')}
      icon={<PlatformIcon provider={c.provider} size="md" />}
      name={<span title={c.display_name}>{c.display_name}</span>}
      badge={c.is_mock && mixed ? <SimulatedBadge /> : null}
      detail={<span className="block truncate">{PROVIDER_LABEL[c.provider]}{c.username ? ` · @${c.username.replace(/^@/, '')}` : ''}</span>}
      actions={manage ? (
        <Menu>
          <MenuTrigger asChild>
            <IconButton label={`Actions for ${c.display_name}`} icon={<Ellipsis aria-hidden className="size-4" />} />
          </MenuTrigger>
          <MenuContent>
            <MenuLabel>{checking ? 'Checking…' : c.health?.checked_at ? `Checked ${fmtRelative(c.health.checked_at)}` : 'Not checked yet'}</MenuLabel>
            <MenuItem icon={<RefreshCw aria-hidden />} onSelect={() => void check()} disabled={disconnected}>Check now</MenuItem>
            {diagOn ? <MenuItem icon={<Stethoscope aria-hidden />} onSelect={() => setDiagOpen(true)}>Diagnostics</MenuItem> : null}
            {!disconnected ? (
              c.paused
                ? <MenuItem icon={<Play aria-hidden />} onSelect={() => setPauseOpen(true)}>Resume</MenuItem>
                : <MenuItem icon={<Pause aria-hidden />} onSelect={() => setPauseOpen(true)}>Pause</MenuItem>
            ) : null}
            <MenuItem icon={<Plug aria-hidden />} onSelect={() => void reconnect()}>Reconnect</MenuItem>
            {c.is_mock && !disconnected ? <MenuItem icon={<FlaskConical aria-hidden />} onSelect={() => setSimOpen(true)}>Simulation outcome…</MenuItem> : null}
            {!disconnected ? (
              <>
                <MenuSeparator />
                <MenuItem icon={<Unplug aria-hidden />} danger onSelect={() => setDisconnectOpen(true)}>Disconnect…</MenuItem>
              </>
            ) : null}
          </MenuContent>
        </Menu>
      ) : null}
    >
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <CapabilityBadge state={state} />
        {state === 'reconnect_required' && manage ? <Button size="sm" variant="secondary" onClick={() => void reconnect()}>Reconnect</Button> : null}
      </div>
      {note ? <p className="mt-2 line-clamp-2 text-xs text-muted" title={note}>{note}</p> : null}
      {formats === null && caps.canReadMetrics === undefined ? null : (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-subtle">Publishes</dt>
          <dd className="min-w-0 truncate">{formats ? (formats.length ? formats.join(' · ') : 'Nothing yet') : <span className="text-muted">Unknown</span>}</dd>
          <dt className="text-subtle">Analytics</dt>
          <dd className="flex items-center gap-1">
            {caps.canReadMetrics === undefined ? <span className="text-muted">Unknown</span>
              : caps.canReadMetrics ? <><ChartColumn aria-hidden className="size-3.5 text-success" />Available</>
                : <span className="text-muted">Not available</span>}
          </dd>
        </dl>
      )}
      {c.health?.expires_at || (c.throttled_until && new Date(c.throttled_until).getTime() > Date.now()) ? (
        <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-3 text-[11px] text-subtle">
          {c.health?.expires_at ? <span>Expires <TimeWithZone instant={c.health.expires_at} tz="UTC" format="date" /></span> : null}
          {c.throttled_until && new Date(c.throttled_until).getTime() > Date.now() ? <span className="text-warn">Rate limited until <TimeWithZone instant={c.throttled_until} tz="UTC" format="time" /></span> : null}
        </div>
      ) : null}

      {diagOpen ? <DiagnosticsDrawer connectionId={c.id} open onOpenChange={setDiagOpen} /> : null}
      <Dialog open={simOpen} onOpenChange={setSimOpen} size="sm" title="Simulation outcome" footer={<Button onClick={() => setSimOpen(false)}>Done</Button>}>
        <label htmlFor={`sc-${c.id}`} className="sr-only">Simulation outcome</label>
        <Select id={`sc-${c.id}`} value={c.mock_scenario ?? 'success'} onChange={(e) => void setScenario(e.target.value as MockScenario)}>
          {MOCK_SCENARIOS.map((x) => <option key={x} value={x}>{MOCK_SCENARIO_LABEL[x]}</option>)}
        </Select>
      </Dialog>
      <ConfirmDialog
        open={pauseOpen}
        onOpenChange={setPauseOpen}
        title={c.paused ? `Resume ${c.display_name}?` : `Pause ${c.display_name}?`}
        description={c.paused ? 'Posts still before their deadline will send.' : 'Posts here won’t send. Missed deadlines expire. Others unaffected.'}
        confirmLabel={c.paused ? 'Resume' : 'Pause'}
        confirmVariant={c.paused ? 'primary' : 'danger'}
        onConfirm={async () => {
          onChanged(await api.post<Connection>(`/api/connections/${c.id}/pause`, { paused: !c.paused }));
          toast.success(c.paused ? 'Resumed' : 'Paused');
        }}
      />
      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title={`Disconnect ${c.display_name}?`}
        confirmLabel="Disconnect"
        confirmVariant="danger"
        onConfirm={async () => {
          const r = await api.post<{ connection: Connection; blocked_deliveries: number }>(`/api/connections/${c.id}/disconnect`, {});
          onChanged(r.connection);
          toast.success('Disconnected', r.blocked_deliveries ? `${plural(r.blocked_deliveries, 'scheduled delivery', 'scheduled deliveries')} blocked` : undefined);
        }}
      >
        <ul className="list-disc space-y-1 pl-4 text-[13px] text-muted">
          <li>Scheduled posts to it become <span className="text-fg">Blocked</span>.</li>
          <li>Published posts stay on {PROVIDER_LABEL[c.provider]}.</li>
        </ul>
      </ConfirmDialog>
    </IntegrationCard>
  );
}

