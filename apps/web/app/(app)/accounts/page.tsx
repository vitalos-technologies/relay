'use client';
import { useState } from 'react';
import { Ellipsis, FlaskConical, Pause, Play, Plug, Plus, RefreshCw, Unplug } from 'lucide-react';
import { PROVIDERS, PROVIDER_LABEL, type Provider } from '@social-lite/core';
import { api, isApiError } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { useBrandFilter, useQueryState } from '@/lib/client/hooks';
import { connectionFix } from '@/lib/client/connection-fix';
import { fmtRelative, plural } from '@/lib/client/format';
import type { Connection, MockScenario, ProviderStatus, SessionBrand } from '@/lib/client/types';
import {
  Banner, Button, Card, ConfirmDialog, ConnectionStatusBadge, EmptyState, ErrorState, IconButton, Menu, MenuContent, MenuItem,
  MenuLabel, MenuSeparator, MenuTrigger, PageHeader, PlatformIcon, Select, SimulatedBadge, SkeletonRows, TimeWithZone, useToast,
} from '@/components/ui';
import { MOCK_SCENARIOS, MOCK_SCENARIO_LABEL, MockDialog, NotConfiguredDialog, TelegramDialog } from '@/components/accounts/connect-dialogs';

const OAUTH: Provider[] = ['facebook', 'instagram', 'x'];
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

export default function AccountsPage() {
  const { session, can } = useSession();
  const [brand] = useBrandFilter();
  const [params, setParams] = useQueryState();
  const providers = useApi<{ items: ProviderStatus[] }>('/api/providers');
  const brands = brand ? session.brands.filter((b) => b.id === brand) : session.brands;
  const err = params.get('error');
  const connected = params.get('connected');

  return (
    <>
      <PageHeader title="Accounts" />
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
        <div className="flex flex-col gap-10">
          {brands.map((b) => <BrandConnections key={b.id} brand={b} providers={providers.data?.items ?? []} showHeading={brands.length > 1} />)}
        </div>
      )}
    </>
  );
}

function BrandConnections({ brand, providers, showHeading }: { brand: SessionBrand; providers: ProviderStatus[]; showHeading: boolean }) {
  const { session, can } = useSession();
  const toast = useToast();
  const { data, error, loading, refetch, setData } = useApi<{ items: Connection[] }>(`/api/brands/${brand.id}/connections`, {
    poll: (d) => (d?.items.some((c) => c.status === 'pending_verification') ? 5_000 : false),
  });
  const [tg, setTg] = useState<{ reconnect: Connection | null } | null>(null);
  const [mockOpen, setMockOpen] = useState(false);
  const [notConfigured, setNotConfigured] = useState<Provider | null>(null);
  const [starting, setStarting] = useState<Provider | null>(null);
  const manage = can('connections.manage');
  const status = (p: Provider) => providers.find((x) => x.provider === p);

  const upsert = (c: Connection) => setData((d) => ({ items: d?.items.some((x) => x.id === c.id) ? d.items.map((x) => (x.id === c.id ? c : x)) : [...(d?.items ?? []), c] }));

  const startOAuth = async (p: Provider) => {
    const st = status(p);
    if (st && !st.configured) {
      setNotConfigured(p);
      return;
    }
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

  const items = (data?.items ?? []).slice().sort((a, b) => Number(a.status === 'disconnected') - Number(b.status === 'disconnected'));
  const grouped = PROVIDERS.map((p) => ({ p, list: items.filter((c) => c.provider === p) })).filter((g) => g.list.length);

  return (
    <section aria-labelledby={`b-${brand.id}`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 id={`b-${brand.id}`} className={showHeading ? 'text-[17px] font-semibold' : 'sr-only'}>
          {brand.name}{brand.publishing_paused ? <span className="ml-2 text-xs font-normal text-warn">Paused</span> : null}
        </h2>
        {manage ? (
          <Menu>
            <MenuTrigger asChild>
              <Button variant="primary" icon={<Plus aria-hidden className="size-4" />} loading={!!starting}>{starting ? `Opening ${PROVIDER_LABEL[starting]}…` : 'Connect'}</Button>
            </MenuTrigger>
            <MenuContent>
              <MenuLabel>Connect to {brand.name}</MenuLabel>
              {OAUTH.map((p) => (
                <MenuItem key={p} icon={<PlatformIcon provider={p} size="xs" decorative />} onSelect={() => void startOAuth(p)}>
                  {PROVIDER_LABEL[p]}{status(p) && !status(p)!.configured ? <span className="ml-auto text-[11px] text-muted">Not set up</span> : null}
                </MenuItem>
              ))}
              <MenuItem icon={<PlatformIcon provider="telegram" size="xs" decorative />} onSelect={() => setTg({ reconnect: null })}>Telegram channel</MenuItem>
              {session.mock_providers_enabled ? (
                <>
                  <MenuSeparator />
                  <MenuItem icon={<FlaskConical aria-hidden />} onSelect={() => setMockOpen(true)}>Simulated destination</MenuItem>
                </>
              ) : null}
            </MenuContent>
          </Menu>
        ) : null}
      </div>

      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows rows={2} /> : !grouped.length ? (
        <EmptyState icon={<Plug aria-hidden />} title="No accounts yet" compact />
      ) : (
        <div className="flex flex-col gap-6">
          {grouped.map(({ p, list }) => (
            <div key={p}>
              <h3 className="mb-3 flex items-center gap-2 text-[13px] font-medium text-muted">
                <PlatformIcon provider={p} size="xs" decorative /> {PROVIDER_LABEL[p]} <span className="tabular">({list.length})</span>
              </h3>
              <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {list.map((c) => (
                  <ConnectionCard
                    key={c.id}
                    c={c}
                    manage={manage}
                    onChanged={upsert}
                    onReconnectTelegram={() => setTg({ reconnect: c })}
                    onNotConfigured={() => setNotConfigured(c.provider)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <TelegramDialog open={!!tg} onOpenChange={(o) => !o && setTg(null)} brandId={brand.id} reconnect={tg?.reconnect} onDone={(c) => { upsert(c); toast.success(c.status === 'ready' ? 'Telegram channel ready' : `Connected — ${c.status_label}`, connectionFix(c) ?? undefined); }} />
      <MockDialog open={mockOpen} onOpenChange={setMockOpen} brandId={brand.id} onDone={(c) => { upsert(c); toast.success('Simulated destination added'); }} />
      <NotConfiguredDialog provider={notConfigured} status={notConfigured ? status(notConfigured) : undefined} open={!!notConfigured} onOpenChange={(o) => !o && setNotConfigured(null)} />
    </section>
  );
}

function ConnectionCard({
  c, manage, onChanged, onReconnectTelegram, onNotConfigured,
}: { c: Connection; manage: boolean; onChanged: (c: Connection) => void; onReconnectTelegram: () => void; onNotConfigured: () => void }) {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const fix = connectionFix(c);
  const disconnected = c.status === 'disconnected';
  const healthNote = c.status !== 'ready' && c.health?.message && c.health.message !== fix ? c.health.message : null;

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
    if (c.provider === 'telegram' && !c.is_mock) return onReconnectTelegram();
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
    <Card as="li" className="flex flex-col" aria-label={`${PROVIDER_LABEL[c.provider]} ${c.display_name}`}>
      <div className="flex items-start gap-3 p-4">
        <PlatformIcon provider={c.provider} size="md" />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <span className="truncate">{c.display_name}</span>
            {c.is_mock ? <SimulatedBadge className="shrink-0" /> : null}
          </p>
          <p className="truncate text-xs text-subtle" title={c.provider_account_id}>
            {c.username ? `@${c.username.replace(/^@/, '')} · ` : ''}ID <code className="font-mono text-[11px]">{c.provider_account_id}</code>
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ConnectionStatusBadge status={c.status} label={c.status_label} size="sm" />
            {c.paused && c.status !== 'paused' ? <ConnectionStatusBadge status="paused" size="sm" /> : null}
          </div>
        </div>
        {manage ? (
          <Menu>
            <MenuTrigger asChild>
              <IconButton label={`Actions for ${c.display_name}`} icon={<Ellipsis aria-hidden className="size-4" />} />
            </MenuTrigger>
            <MenuContent>
              <MenuItem icon={<RefreshCw aria-hidden />} onSelect={() => void check()} disabled={disconnected}>Check</MenuItem>
              {!disconnected ? (
                c.paused
                  ? <MenuItem icon={<Play aria-hidden />} onSelect={() => setPauseOpen(true)}>Resume</MenuItem>
                  : <MenuItem icon={<Pause aria-hidden />} onSelect={() => setPauseOpen(true)}>Pause</MenuItem>
              ) : null}
              <MenuItem icon={<Plug aria-hidden />} onSelect={() => void reconnect()}>Reconnect</MenuItem>
              {!disconnected ? (
                <>
                  <MenuSeparator />
                  <MenuItem icon={<Unplug aria-hidden />} danger onSelect={() => setDisconnectOpen(true)}>Disconnect…</MenuItem>
                </>
              ) : null}
            </MenuContent>
          </Menu>
        ) : null}
      </div>

      {fix || healthNote ? (
        <p className="px-4 pb-2 pl-[60px] text-xs">
          {fix ? <span className="text-fg">{fix}</span> : null}
          {healthNote ? <span className="block truncate text-muted" title={healthNote}>{healthNote}</span> : null}
        </p>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pb-4 pl-[60px] text-xs text-subtle">
        <span>{checking ? 'Checking…' : c.health?.checked_at ? <>Checked {fmtRelative(c.health.checked_at)}</> : 'Not checked'}</span>
        {c.health?.expires_at ? <span>Expires <TimeWithZone instant={c.health.expires_at} tz="UTC" format="date" /></span> : null}
        {c.throttled_until && new Date(c.throttled_until).getTime() > Date.now() ? <span className="text-warn">Rate limited until <TimeWithZone instant={c.throttled_until} tz="UTC" format="time" /></span> : null}
        {c.is_mock && manage && !disconnected ? (
          <span className="flex min-w-0 items-center gap-2 sm:ml-auto">
            <label htmlFor={`sc-${c.id}`} className="sr-only">Simulated behaviour</label>
            <Select id={`sc-${c.id}`} value={c.mock_scenario ?? 'success'} onChange={(e) => void setScenario(e.target.value as MockScenario)} className="w-[200px] max-w-full">
              {MOCK_SCENARIOS.map((s) => <option key={s} value={s}>{MOCK_SCENARIO_LABEL[s]}</option>)}
            </Select>
          </span>
        ) : null}
      </div>

      <ConfirmDialog
        open={pauseOpen}
        onOpenChange={setPauseOpen}
        title={c.paused ? `Resume ${c.display_name}?` : `Pause ${c.display_name}?`}
        description={c.paused
          ? 'Posts still before their deadline will send.'
          : 'Posts here won’t send. Missed deadlines expire. Others unaffected.'}
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
    </Card>
  );
}
