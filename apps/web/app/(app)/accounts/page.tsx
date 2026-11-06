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
  access_denied: 'Authorisation was cancelled on the network’s site. Nothing was connected.',
  invalid_state: 'The connection link expired or was already used. Start again.',
  state_mismatch: 'The connection link expired or was already used. Start again.',
  no_destinations: 'The account you authorised has no pages or profiles you can publish to.',
  provider_error: 'The network returned an error while connecting. Try again in a few minutes.',
  provider_not_configured: 'This network isn’t configured yet. The workspace owner can add it in Setup.',
  session_required: 'Your session ended during authorisation. Sign in and start connecting again.',
  session_mismatch: 'This connection was started by a different signed-in user. Start again from this account.',
  authorization_failed: 'The network didn’t complete authorisation. Start again.',
  token_exchange_failed: 'The network didn’t confirm access. Start again in a few minutes.',
  destinations_failed: 'We couldn’t list the pages or profiles for this account. Try again in a few minutes.',
  invalid_provider: 'That network isn’t supported.',
  forbidden: 'You don’t have permission to connect accounts for this brand.',
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
      <PageHeader title="Accounts" description="Connected destinations for each brand, their health and exactly what to fix." />
      {err ? (
        <Banner tone="danger" role="alert" className="mb-5" title="Couldn’t connect the account" actions={<Button size="sm" variant="ghost" onClick={() => setParams({ error: null })}>Dismiss</Button>}>
          {CALLBACK_ERRORS[err] ?? 'Something went wrong while connecting.'} <span className="font-mono text-[11px] text-subtle">({err})</span>
        </Banner>
      ) : null}
      {connected ? (
        <Banner tone="success" role="status" className="mb-5" title={`${plural(Number(connected) || 0, 'destination')} connected`} actions={<Button size="sm" variant="ghost" onClick={() => setParams({ connected: null })}>Dismiss</Button>}>
          Each one shows Ready only after its permissions are verified.
        </Banner>
      ) : null}
      {!can('connections.manage') ? <Banner tone="info" className="mb-5">Only owners and admins can connect or change accounts. You can see their status here.</Banner> : null}
      {!brands.length ? (
        <EmptyState icon={<Plug aria-hidden />} title="No brands yet">Create a brand in Settings, then connect its accounts here.</EmptyState>
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
          {brand.name}{brand.publishing_paused ? <span className="ml-2 text-xs font-normal text-warn">Publishing paused</span> : null}
        </h2>
        {manage ? (
          <Menu>
            <MenuTrigger asChild>
              <Button variant="primary" icon={<Plus aria-hidden className="size-4" />} loading={!!starting}>{starting ? `Opening ${PROVIDER_LABEL[starting]}…` : 'Connect account'}</Button>
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
                  <MenuItem icon={<FlaskConical aria-hidden />} onSelect={() => setMockOpen(true)}>Add simulated destination</MenuItem>
                </>
              ) : null}
            </MenuContent>
          </Menu>
        ) : null}
      </div>

      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows rows={2} /> : !grouped.length ? (
        <EmptyState icon={<Plug aria-hidden />} title="No accounts connected" compact>
          {manage ? 'Connect Instagram, Facebook, Telegram or X. You’ll explicitly choose which pages or profiles to add.' : 'An owner or admin can connect accounts for this brand.'}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-6">
          {grouped.map(({ p, list }) => (
            <div key={p}>
              <h3 className="mb-2 flex items-center gap-2 text-[13px] font-medium text-muted">
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
        <PlatformIcon provider={c.provider} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <span className="truncate">{c.display_name}</span>
            {c.is_mock ? <SimulatedBadge /> : null}
          </p>
          <p className="truncate text-xs text-muted">
            {c.username ? `@${c.username.replace(/^@/, '')} · ` : ''}ID <code className="font-mono text-[11px]">{c.provider_account_id}</code>
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ConnectionStatusBadge status={c.status} label={c.status_label} />
            {c.paused && c.status !== 'paused' ? <ConnectionStatusBadge status="paused" /> : null}
          </div>
        </div>
        {manage ? (
          <Menu>
            <MenuTrigger asChild>
              <IconButton label={`Actions for ${c.display_name}`} icon={<Ellipsis aria-hidden className="size-4" />} />
            </MenuTrigger>
            <MenuContent>
              <MenuItem icon={<RefreshCw aria-hidden />} onSelect={() => void check()} disabled={disconnected}>Check now</MenuItem>
              {!disconnected ? (
                c.paused
                  ? <MenuItem icon={<Play aria-hidden />} onSelect={() => setPauseOpen(true)}>Resume publishing</MenuItem>
                  : <MenuItem icon={<Pause aria-hidden />} onSelect={() => setPauseOpen(true)}>Pause publishing</MenuItem>
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

      {fix || c.health?.message ? (
        <div className="px-4 pb-3">
          <p className="rounded-lg bg-sunken px-3 py-2 text-xs leading-relaxed">
            {fix ? <span className="text-fg">{fix}</span> : null}
            {c.health?.message && c.health.message !== fix ? <span className="mt-0.5 block text-muted">{c.health.message}</span> : null}
          </p>
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-4 py-2.5 text-xs text-muted">
        <span>{checking ? 'Checking…' : c.health?.checked_at ? <>Checked {fmtRelative(c.health.checked_at)}</> : 'Not checked yet'}</span>
        {c.health?.expires_at ? <span>Access expires <TimeWithZone instant={c.health.expires_at} tz="UTC" format="date" /></span> : null}
        {c.throttled_until && new Date(c.throttled_until).getTime() > Date.now() ? <span className="text-warn">Rate limited until <TimeWithZone instant={c.throttled_until} tz="UTC" format="time" /></span> : null}
        {c.is_mock && manage && !disconnected ? (
          <span className="ml-auto flex items-center gap-2">
            <label htmlFor={`sc-${c.id}`}>Behaviour</label>
            <Select id={`sc-${c.id}`} value={c.mock_scenario ?? 'success'} onChange={(e) => void setScenario(e.target.value as MockScenario)} className="w-[220px]">
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
          ? 'Scheduled posts for this destination will send again if they are still before their publish-before deadline.'
          : 'Scheduled posts for this destination won’t send while paused. Anything that passes its deadline while paused expires instead of posting late. Other destinations are unaffected.'}
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
          toast.success('Disconnected', r.blocked_deliveries ? `${plural(r.blocked_deliveries, 'scheduled delivery', 'scheduled deliveries')} to this destination ${r.blocked_deliveries === 1 ? 'is' : 'are'} now blocked.` : 'No scheduled posts were affected.');
        }}
      >
        <ul className="list-disc space-y-1.5 pl-4 text-[13px] text-muted">
          <li>Stored access for this destination is removed and nothing new will be sent to it.</li>
          <li>Posts already scheduled to it become <span className="text-fg">Blocked</span> — they won’t send, and other destinations on the same posts are unaffected.</li>
          <li>Posts already published stay on {PROVIDER_LABEL[c.provider]}.</li>
          <li>Connecting a different account later creates a new destination; old schedules are never silently redirected.</li>
        </ul>
      </ConfirmDialog>
    </Card>
  );
}
