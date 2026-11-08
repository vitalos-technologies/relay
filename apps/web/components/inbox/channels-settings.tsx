'use client';
// Settings → Inbox → Channels (stream B): channels in the inbox (status, missing permissions, per-network actions:
// Telegram update ownership, WhatsApp templates + rate card, polling "Check now", satisfaction requests, simulate) and
// "Add channel": pick a network → pick an account (simulated accounts are a secondary option, dev/demo only). The
// capability table states what each network allows and whether live use needs the provider's approval.
import { useMemo, useState } from 'react';
import { CircleAlert, CircleCheck, FlaskConical, MoreHorizontal, Plus, RefreshCw } from 'lucide-react';
import type { ChannelCapability, ChannelKind, InboxChannelJson, Support } from '@social-lite/core/contracts/v35-inbox';
import type { IntegrationConnectionJson } from '@social-lite/core/contracts/v35-connectors';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import type { Connection } from '@/lib/client/types';
import {
  Badge, Banner, Button, Card, CardHeader, Checkbox, Dialog, EmptyState, ErrorState, Field, IconButton, Input, LinkButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger,
  PlatformIcon, Select, SimulatedBadge, SkeletonRows, Table, THead, Th, Tr, Td, Textarea, cn, useToast,
} from '@/components/ui';
import { CHANNEL_LABEL, CHANNEL_PROVIDER } from './labels';

type Cap = ChannelCapability & { implemented: boolean; live_requires_approval?: boolean };
const SUPPORT: Record<Support, { label: string; tone: 'success' | 'warn' | 'neutral' | 'info' }> = {
  supported: { label: 'Supported', tone: 'success' }, needs_approval: { label: 'Needs approval', tone: 'warn' },
  not_available: { label: 'Not available', tone: 'neutral' }, not_implemented: { label: 'Not built yet', tone: 'info' },
};
const NETWORK_ORDER: ChannelKind[] = ['facebook_page', 'instagram', 'whatsapp', 'google_business_profile', 'telegram_bot', 'youtube', 'bluesky', 'threads', 'x', 'linkedin', 'tiktok'];
const SOCIAL_PROVIDER: Partial<Record<ChannelKind, string>> = { facebook_page: 'facebook', instagram: 'instagram', telegram_bot: 'telegram', youtube: 'youtube', bluesky: 'bluesky', threads: 'threads' };
const INTEGRATION: Partial<Record<ChannelKind, 'whatsapp' | 'google_business_profile'>> = { whatsapp: 'whatsapp', google_business_profile: 'google_business_profile' };
const POLLING: ChannelKind[] = ['youtube', 'bluesky', 'threads', 'google_business_profile'];
const CSAT: ChannelKind[] = ['facebook_page', 'instagram', 'telegram_bot', 'whatsapp', 'bluesky'];
const SIM_KINDS: Record<ChannelKind, Array<{ value: 'dm' | 'comment' | 'mention' | 'review'; label: string }>> = {
  facebook_page: [{ value: 'dm', label: 'Private message' }, { value: 'comment', label: 'Comment on a post' }],
  instagram: [{ value: 'dm', label: 'Direct message' }, { value: 'comment', label: 'Comment' }],
  whatsapp: [{ value: 'dm', label: 'Message' }],
  google_business_profile: [{ value: 'review', label: 'Review' }],
  telegram_bot: [{ value: 'dm', label: 'Private chat' }, { value: 'comment', label: 'Group message' }],
  youtube: [{ value: 'comment', label: 'Comment' }],
  bluesky: [{ value: 'comment', label: 'Reply' }, { value: 'mention', label: 'Mention' }, { value: 'dm', label: 'Direct message' }],
  threads: [{ value: 'comment', label: 'Reply' }],
  x: [], linkedin: [], tiktok: [],
};

function NetworkIcon({ kind }: { kind: ChannelKind }) {
  const p = CHANNEL_PROVIDER[kind];
  return p ? <PlatformIcon provider={p} size="sm" /> : <span aria-hidden className="inline-flex size-5 items-center justify-center rounded bg-raised text-[10px] font-semibold text-muted">{kind === 'whatsapp' ? 'WA' : 'G'}</span>;
}

function statusBadge(c: InboxChannelJson) {
  const label = c.status === 'active' ? 'Receiving' : c.status === 'paused' ? 'Paused' : c.status === 'needs_permission' ? (c.kind === 'telegram_bot' && c.missing_permissions.includes('telegram_updates') ? 'Not receiving yet' : 'Permission missing') : c.status === 'disconnected' ? 'Removed' : 'Needs attention';
  return <Badge tone={c.status === 'active' ? 'success' : c.status === 'paused' ? 'neutral' : 'warn'} icon={c.status === 'active' ? <CircleCheck aria-hidden className="size-3.5" /> : <CircleAlert aria-hidden className="size-3.5" />}>{label}</Badge>;
}

export function InboxChannelsSettings() {
  const toast = useToast();
  const { canV2 } = useSession();
  const channels = useApi<{ items: InboxChannelJson[] }>('/api/inbox/channels');
  const caps = useApi<{ items: Cap[] }>('/api/inbox/capabilities');
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [sim, setSim] = useState<InboxChannelJson | null>(null);
  const [tg, setTg] = useState<InboxChannelJson | null>(null);
  const [wa, setWa] = useState<InboxChannelJson | null>(null);
  const manage = canV2('inbox.manage');
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast.success(ok); await channels.refetch(); } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const capOf = (k: ChannelKind) => caps.data?.items.find((c) => c.kind === k);

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <Card aria-labelledby="h-ch">
        <CardHeader id="h-ch" title="Channels in the inbox" actions={manage ? <Button size="sm" variant="secondary" icon={<Plus aria-hidden className="size-4" />} onClick={() => setAdding(true)}>Add channel</Button> : undefined} />
        {channels.error ? <ErrorState error={channels.error} onRetry={channels.refetch} /> : !channels.data ? <SkeletonRows rows={2} className="p-4" /> : !channels.data.items.length ? (
          <EmptyState compact title="No channels in the inbox yet" action={manage ? <Button variant="secondary" onClick={() => setAdding(true)}>Add channel</Button> : undefined} />
        ) : (
          <ul className="divide-y divide-border">
            {channels.data.items.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <NetworkIcon kind={c.kind} />
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 flex-wrap items-center gap-2 text-[14px] font-medium"><span className="min-w-0 break-words">{c.display_name}</span>{c.is_simulated ? <SimulatedBadge /> : null}</p>
                  <p className="text-xs text-muted">{CHANNEL_LABEL[c.kind]} · {c.enabled_types.map((t) => (t === 'dm' ? 'messages' : `${t}s`)).join(', ')}{c.options?.csat_enabled ? ' · ratings on' : ''}{c.options?.poll?.last_success_at ? ` · checked ${new Date(c.options.poll.last_success_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</p>
                  {c.status !== 'active' && c.status_detail ? <p className="mt-1 text-xs text-warn">{c.status_detail}</p> : null}
                  {c.missing_permissions.length && !c.missing_permissions.includes('telegram_updates') ? <p className="mt-1 text-xs text-warn">Missing: {c.missing_permissions.join(', ')}</p> : null}
                  {c.options?.poll?.last_error ? <p className="mt-1 text-xs text-warn">Last check failed: {c.options.poll.last_error}</p> : null}
                </div>
                {statusBadge(c)}
                {c.kind === 'telegram_bot' && manage && c.status !== 'active' && c.status !== 'paused' ? <Button size="sm" variant="secondary" onClick={() => setTg(c)}>Connect updates</Button> : null}
                {manage ? (
                  <Menu>
                    <MenuTrigger asChild><IconButton label={`Actions for ${c.display_name}`} icon={<MoreHorizontal className="size-4" />} variant="ghost" /></MenuTrigger>
                    <MenuContent>
                      {c.is_simulated && SIM_KINDS[c.kind].length ? <MenuItem icon={<FlaskConical aria-hidden className="size-4" />} onSelect={() => setSim(c)}>Simulate a customer message</MenuItem> : null}
                      {POLLING.includes(c.kind) && c.status === 'active' ? <MenuItem icon={<RefreshCw aria-hidden className="size-4" />} onSelect={() => run(c.id, () => api.post(`/api/inbox/channels/${c.id}/poll`, {}), 'Checked')}>Check now</MenuItem> : null}
                      {c.kind === 'telegram_bot' ? <MenuItem onSelect={() => setTg(c)}>Telegram updates…</MenuItem> : null}
                      {c.kind === 'whatsapp' ? <MenuItem onSelect={() => setWa(c)}>Templates and charges…</MenuItem> : null}
                      {CSAT.includes(c.kind) ? <MenuItem onSelect={() => run(c.id, () => api.put(`/api/inbox/channels/${c.id}/csat`, { enabled: !c.options?.csat_enabled }), c.options?.csat_enabled ? 'Rating requests off' : 'Rating requests on')}>{c.options?.csat_enabled ? 'Turn off rating requests' : 'Turn on rating requests'}</MenuItem> : null}
                      <MenuSeparator />
                      <MenuItem onSelect={() => run(c.id, () => api.patch(`/api/inbox/channels/${c.id}`, { paused: c.status !== 'paused' }), c.status === 'paused' ? 'Resumed' : 'Paused')}>{c.status === 'paused' ? 'Resume' : 'Pause'}</MenuItem>
                    </MenuContent>
                  </Menu>
                ) : null}
                {busy === c.id ? <span className="sr-only">Working…</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card aria-labelledby="h-cap">
        <CardHeader id="h-cap" title="What each network allows" />
        {!caps.data ? <SkeletonRows rows={4} className="p-4" /> : (
          <>
            <div className="overflow-x-auto px-1 pb-2">
              <Table caption="Inbox capabilities by network">
                <THead><Tr><Th>Network</Th><Th>Messages</Th><Th>Comments</Th><Th>Reviews / mentions</Th><Th>In Relay</Th></Tr></THead>
                <tbody>
                  {NETWORK_ORDER.map((k) => capOf(k)).filter((c): c is Cap => !!c).map((c) => {
                    const cell = (kk: 'dm' | 'comment' | 'review' | 'mention') => { const v = c.conversationTypes[kk]; return v ? <Badge tone={SUPPORT[v.reply].tone}>{SUPPORT[v.reply].label}</Badge> : <span className="text-subtle">—</span>; };
                    return (
                      <Tr key={c.kind}>
                        <Td className="font-medium">{CHANNEL_LABEL[c.kind]}</Td>
                        <Td>{cell('dm')}</Td><Td>{cell('comment')}</Td><Td>{c.conversationTypes.review ? cell('review') : cell('mention')}</Td>
                        <Td>{c.implemented ? <span className="inline-flex items-center gap-1"><Badge tone="success">Built</Badge>{c.live_requires_approval ? <sup className="text-xs text-warn" title="Built and testable with simulated accounts. Live use needs the network’s approval.">*</sup> : null}</span> : <span className="text-xs text-muted">Not yet</span>}</Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            </div>
            <p className="px-4 pb-4 text-xs text-muted"><span className="text-warn">*</span> Built and testable with simulated accounts. Live use needs the network’s approval first.</p>
          </>
        )}
      </Card>
      {adding ? <AddChannelDialog caps={caps.data?.items ?? []} existing={channels.data?.items ?? []} onClose={() => setAdding(false)} onAdded={() => { void channels.refetch(); }} /> : null}
      {sim ? <SimulateDialog channel={sim} onClose={() => setSim(null)} /> : null}
      {tg ? <TelegramDialog channel={tg} onClose={() => setTg(null)} onChanged={() => void channels.refetch()} /> : null}
      {wa ? <WhatsAppDialog channel={wa} onClose={() => setWa(null)} onChanged={() => void channels.refetch()} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------ Add channel
function AddChannelDialog({ caps, existing, onClose, onAdded }: { caps: Cap[]; existing: InboxChannelJson[]; onClose: () => void; onAdded: () => void }) {
  const { session } = useSession();
  const [kind, setKind] = useState<ChannelKind | null>(null);
  const [brand, setBrand] = useState(session.brands[0]?.id ?? '');
  const cap = kind ? caps.find((c) => c.kind === kind) : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="lg" title={kind ? `Add ${CHANNEL_LABEL[kind]}` : 'Add channel'} description={kind ? undefined : 'Pick a network, then the account to use in the inbox.'}
      footer={kind ? <Button variant="ghost" onClick={() => setKind(null)}>Back</Button> : <Button variant="ghost" onClick={onClose}>Close</Button>}>
      {!kind ? (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {NETWORK_ORDER.map((k) => {
            const c = caps.find((x) => x.kind === k);
            const state = !c?.implemented ? (Object.values(c?.conversationTypes ?? {}).some((t) => t?.read === 'needs_approval') ? 'Needs provider approval' : 'Not available') : c.live_requires_approval ? 'Built · live use needs approval' : 'Available';
            return (
              <li key={k}>
                <button type="button" onClick={() => setKind(k)} className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left hover:bg-raised">
                  <NetworkIcon kind={k} />
                  <span className="min-w-0 flex-1"><span className="block text-[14px] font-medium">{CHANNEL_LABEL[k]}</span><span className={cn('block text-xs', c?.implemented ? 'text-muted' : 'text-subtle')}>{state}</span></span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex flex-col gap-4">
          {session.brands.length > 1 ? <Field label="Brand"><Select value={brand} onChange={(e) => setBrand(e.target.value)}>{session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field> : null}
          {!cap?.implemented ? (
            <Banner tone="info" title="Not available in Relay yet">
              <p className="text-[13px]">{CHANNEL_LABEL[kind]} needs provider approval before Relay can read or reply:</p>
              <ul className="mt-1 list-disc pl-5 text-[13px]">{(cap?.requires ?? []).map((r) => <li key={r}>{r}</li>)}</ul>
            </Banner>
          ) : INTEGRATION[kind] ? (
            <IntegrationAccounts kind={kind} connector={INTEGRATION[kind]!} brand={brand} existing={existing} onAdded={onAdded} />
          ) : (
            <SocialAccounts kind={kind} provider={SOCIAL_PROVIDER[kind]!} brand={brand} existing={existing} onAdded={onAdded} />
          )}
          {cap?.implemented && cap.live_requires_approval ? <p className="text-xs text-muted">Live accounts need: {cap.requires.slice(0, 2).join(' · ')}</p> : null}
        </div>
      )}
    </Dialog>
  );
}

function SocialAccounts({ kind, provider, brand, existing, onAdded }: { kind: ChannelKind; provider: string; brand: string; existing: InboxChannelJson[]; onAdded: () => void }) {
  const toast = useToast();
  const { session } = useSession();
  const conns = useApi<{ items: Connection[] }>(brand ? `/api/brands/${brand}/connections` : null);
  const [busy, setBusy] = useState<string | null>(null);
  const used = new Set(existing.map((c) => c.connection_id));
  const list = (conns.data?.items ?? []).filter((c) => c.provider === provider && !c.disconnected_at);
  const add = async (connectionId: string) => {
    setBusy(connectionId);
    try { await api.post('/api/inbox/channels', { connection_id: connectionId }); toast.success('Channel added'); await conns.refetch(); onAdded(); } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const simulated = async () => {
    setBusy('sim');
    try { const c = await api.post<Connection>(`/api/brands/${brand}/connections/mock`, { provider, display_name: `${CHANNEL_LABEL[kind]} (simulated)` }); await add(c.id); } catch (e) { toast.error(e); setBusy(null); }
  };
  if (!conns.data) return <SkeletonRows rows={2} />;
  return (
    <div className="flex flex-col gap-3">
      {list.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {list.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1 break-words text-[14px]">{c.display_name}{c.is_mock ? <SimulatedBadge className="ml-2" /> : null}</span>
              {used.has(c.id) ? <Badge tone="success">In the inbox</Badge> : <Button size="sm" variant="primary" loading={busy === c.id} onClick={() => add(c.id)}>Add</Button>}
            </li>
          ))}
        </ul>
      ) : <p className="text-[13px] text-muted">No {CHANNEL_LABEL[kind]} account is connected for this brand.</p>}
      <div className="flex flex-wrap items-center gap-3">
        <LinkButton href="/accounts" variant="secondary" size="sm">Connect an account</LinkButton>
        {session.mock_providers_enabled ? <Button size="sm" variant="ghost" icon={<FlaskConical aria-hidden className="size-4" />} loading={busy === 'sim'} onClick={simulated}>Use a simulated account</Button> : null}
      </div>
    </div>
  );
}

function IntegrationAccounts({ kind, connector, brand, existing, onAdded }: { kind: ChannelKind; connector: 'whatsapp' | 'google_business_profile'; brand: string; existing: InboxChannelJson[]; onAdded: () => void }) {
  const toast = useToast();
  const { session, canV2 } = useSession();
  const integ = useApi<{ items: IntegrationConnectionJson[] }>(`/api/connectors?connector=${connector}`);
  const live = (integ.data?.items ?? []).filter((i) => !i.disconnected_at && (!i.brand_id || i.brand_id === brand));
  const [pick, setPick] = useState<string | null>(null);
  const sel = pick ?? live[0]?.id ?? null;
  const accounts = useApi<{ kind: ChannelKind; items: Array<{ account_id: string; name: string; enabled_channel_id: string | null }> }>(sel ? `/api/inbox/integrations/${sel}/accounts` : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [connect, setConnect] = useState(false);
  void existing;
  const add = async (accountId: string) => {
    setBusy(accountId);
    try { await api.post('/api/inbox/channels/integration', { integration_id: sel, account_id: accountId, brand_id: brand }); toast.success('Channel added'); await accounts.refetch(); onAdded(); } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const simulated = async () => {
    setBusy('sim');
    try { const i = await api.post<IntegrationConnectionJson>('/api/connectors', { connector, brand_id: brand }); await integ.refetch(); setPick(i.id); } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  if (!integ.data) return <SkeletonRows rows={2} />;
  return (
    <div className="flex flex-col gap-3">
      {live.length > 1 ? <Field label={connector === 'whatsapp' ? 'WhatsApp Business Account' : 'Google account'}><Select value={sel ?? ''} onChange={(e) => setPick(e.target.value)}>{live.map((i) => <option key={i.id} value={i.id}>{i.display_name}{i.is_simulated ? ' (simulated)' : ''}</option>)}</Select></Field> : null}
      {!live.length ? <p className="text-[13px] text-muted">{connector === 'whatsapp' ? 'No WhatsApp Business Account is connected.' : 'Google Business Profile is not connected yet.'}</p> : accounts.error ? <ErrorState error={accounts.error} onRetry={accounts.refetch} /> : !accounts.data ? <SkeletonRows rows={2} /> : !accounts.data.items.length ? (
        <p className="text-[13px] text-muted">{connector === 'whatsapp' ? 'No phone numbers on this account.' : 'No locations selected. Choose locations in Integrations.'}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {accounts.data.items.map((a) => (
            <li key={a.account_id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1 break-words text-[14px]">{a.name}</span>
              {a.enabled_channel_id ? <Badge tone="success">In the inbox</Badge> : <Button size="sm" variant="primary" loading={busy === a.account_id} onClick={() => add(a.account_id)}>Add</Button>}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {connector === 'whatsapp'
          ? (canV2('integrations.manage') ? <Button size="sm" variant="secondary" onClick={() => setConnect(true)}>Connect WhatsApp</Button> : null)
          : <LinkButton href="/integrations" variant="secondary" size="sm">Open Integrations</LinkButton>}
        {session.mock_providers_enabled ? <Button size="sm" variant="ghost" icon={<FlaskConical aria-hidden className="size-4" />} loading={busy === 'sim'} onClick={simulated}>Use a simulated {connector === 'whatsapp' ? 'account' : 'profile'}</Button> : null}
      </div>
      {kind === 'whatsapp' ? <p className="text-xs text-muted">Template messages are charged by Meta per delivered message. Replies inside 24 hours of the customer’s message are free.</p> : null}
      {connect ? <WhatsAppConnectDialog brand={brand} onClose={() => setConnect(false)} onDone={async (id) => { setConnect(false); await integ.refetch(); setPick(id); }} /> : null}
    </div>
  );
}

function WhatsAppConnectDialog({ brand, onClose, onDone }: { brand: string; onClose: () => void; onDone: (id: string) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ waba_id: '', phone_number_id: '', access_token: '' });
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Connect WhatsApp" description="Use a system-user token from Meta Business Manager. Relay verifies the number with Meta and stores the token encrypted." footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={busy} disabledReason={!f.waba_id || !f.phone_number_id || !f.access_token ? 'Fill in all fields' : null} onClick={async () => {
        setBusy(true);
        try { const i = await api.post<IntegrationConnectionJson>('/api/inbox/whatsapp/connect', { brand_id: brand, ...f }); toast.success('WhatsApp connected'); onDone(i.id); } catch (e) { toast.error(e); } finally { setBusy(false); }
      }}>Verify and connect</Button>
    </>}>
      <div className="flex flex-col gap-3">
        <Field label="WhatsApp Business Account ID"><Input inputMode="numeric" value={f.waba_id} onChange={(e) => setF({ ...f, waba_id: e.target.value.trim() })} /></Field>
        <Field label="Phone number ID"><Input inputMode="numeric" value={f.phone_number_id} onChange={(e) => setF({ ...f, phone_number_id: e.target.value.trim() })} /></Field>
        <Field label="System-user access token"><Input type="password" autoComplete="off" value={f.access_token} onChange={(e) => setF({ ...f, access_token: e.target.value.trim() })} /></Field>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Telegram update ownership
function TelegramDialog({ channel, onClose, onChanged }: { channel: InboxChannelJson; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [state, setState] = useState(channel.options?.telegram ?? null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [checkedHere, setCheckedHere] = useState(false);
  const act = async (action: 'check' | 'claim' | 'release') => {
    setBusy(action);
    try {
      const r = await api.post<{ channel: InboxChannelJson }>(`/api/inbox/channels/${channel.id}/telegram`, { action, ...(action === 'claim' ? { confirm_no_other_consumer: confirm } : {}) });
      setState(r.channel.options?.telegram ?? null);
      if (action === 'check') setCheckedHere(true);
      onChanged();
      if (action === 'claim') toast.success('Relay now receives this bot’s messages');
      if (action === 'release') toast.success('Relay stopped receiving this bot’s messages');
    } catch (e) { toast.error(e); onChanged(); } finally { setBusy(null); }
  };
  const owner = state?.owner ?? 'unknown';
  const fresh = checkedHere;   // the server also refuses a claim without a check in the last 10 minutes
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Telegram updates" description="A bot has one place its messages go: a webhook or another app that polls. Relay never takes over a bot another app uses." footer={<Button variant="ghost" onClick={onClose}>Close</Button>}>
      <div className="flex flex-col gap-3 text-[13px]">
        {owner === 'relay' ? <Banner tone="success" title="Relay receives this bot’s messages" />
          : owner === 'external' ? <Banner tone="warn" title="Another app receives this bot’s messages">Its webhook points to {state?.external_host ?? 'another server'}. Relay will not overwrite it. Remove it in that app first, then check again.</Banner>
            : owner === 'none' ? <Banner tone="info" title="No webhook is set">Another app may still read this bot by polling. Telegram cannot tell Relay.</Banner>
              : <p className="text-muted">Not checked yet.</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" loading={busy === 'check'} onClick={() => act('check')}>Check bot</Button>
          {owner === 'relay' ? <Button size="sm" variant="ghost" loading={busy === 'release'} onClick={() => act('release')}>Stop receiving</Button> : null}
        </div>
        {owner === 'none' && fresh ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <Checkbox label="No other app reads this bot’s messages (no polling, no other webhook)." checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            <div><Button size="sm" variant="primary" loading={busy === 'claim'} disabledReason={!confirm ? 'Confirm first' : null} onClick={() => act('claim')}>Send this bot’s messages to Relay</Button></div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ WhatsApp templates + rate card
function WhatsAppDialog({ channel, onClose, onChanged }: { channel: InboxChannelJson; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const t = useApi<{ items: Array<{ name: string; language: string; category: string | null; status: string; body: string }>; refreshed_at: string | null; rates: Record<string, { amount: number; currency: string }> | null }>(`/api/inbox/channels/${channel.id}/templates`);
  const [busy, setBusy] = useState<string | null>(null);
  const [rates, setRates] = useState<Record<string, string> | null>(null);
  const r = rates ?? Object.fromEntries(['marketing', 'utility', 'authentication'].map((k) => [k, t.data?.rates?.[k] ? String(t.data.rates[k]!.amount) : '']));
  const currency = Object.values(t.data?.rates ?? {})[0]?.currency ?? 'GBP';
  const [cur, setCur] = useState<string | null>(null);
  return (
    <Dialog open size="lg" onOpenChange={(o) => !o && onClose()} title="WhatsApp templates and charges" footer={<Button variant="ghost" onClick={onClose}>Close</Button>}>
      <div className="flex flex-col gap-4 text-[13px]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted">{t.data?.refreshed_at ? `${t.data.items.length} templates · updated ${new Date(t.data.refreshed_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'Not loaded yet.'}</p>
          <Button size="sm" variant="secondary" icon={<RefreshCw aria-hidden className="size-4" />} loading={busy === 'refresh'} onClick={async () => { setBusy('refresh'); try { await api.post(`/api/inbox/channels/${channel.id}/templates`, {}); await t.refetch(); onChanged(); } catch (e) { toast.error(e); } finally { setBusy(null); } }}>Refresh from Meta</Button>
        </div>
        {t.data?.items.length ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {t.data.items.map((x) => (
              <li key={`${x.name}:${x.language}`} className="flex flex-col gap-1 px-3 py-2">
                <span className="flex flex-wrap items-center gap-2"><span className="font-medium">{x.name}</span><span className="text-xs text-muted">{x.language} · {x.category ?? 'other'}</span>{x.status !== 'APPROVED' ? <Badge tone="warn">{x.status.toLowerCase()}</Badge> : null}</span>
                <span className="text-muted">{x.body}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-xs font-medium text-subtle">Rate card for estimates</legend>
          <p className="text-xs text-muted">Meta charges templates per delivered message; rates depend on the recipient’s country. Enter your typical rates to show an estimate before sending. Leave empty to show “charged” without an amount.</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {['marketing', 'utility', 'authentication'].map((k) => <Field key={k} label={k[0]!.toUpperCase() + k.slice(1)}><Input inputMode="decimal" value={r[k] ?? ''} onChange={(e) => setRates({ ...r, [k]: e.target.value })} /></Field>)}
            <Field label="Currency"><Input value={cur ?? currency} maxLength={3} onChange={(e) => setCur(e.target.value.toUpperCase())} /></Field>
          </div>
          <div><Button size="sm" variant="primary" loading={busy === 'rates'} onClick={async () => {
            setBusy('rates');
            const entries = Object.entries(r).filter(([, v]) => v.trim() !== '' && Number.isFinite(Number(v)));
            try { await api.put(`/api/inbox/channels/${channel.id}/rates`, { rates: entries.length ? Object.fromEntries(entries.map(([k, v]) => [k, { amount: Number(v), currency: cur ?? currency }])) : null }); toast.success('Rates saved'); await t.refetch(); onChanged(); } catch (e) { toast.error(e); } finally { setBusy(null); }
          }}>Save rates</Button></div>
        </fieldset>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Simulate (simulated channels only)
function SimulateDialog({ channel, onClose }: { channel: InboxChannelJson; onClose: () => void }) {
  const toast = useToast();
  const kinds = SIM_KINDS[channel.kind];
  const [kind, setKind] = useState(kinds[0]?.value ?? 'dm');
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [rating, setRating] = useState(4);
  const [attachment, setAttachment] = useState(false);
  const [busy, setBusy] = useState(false);
  const canAttach = useMemo(() => ['whatsapp', 'telegram_bot', 'instagram'].includes(channel.kind) && kind === 'dm', [channel.kind, kind]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Simulate a customer message" description={`Simulated channel only. Nothing is received from ${CHANNEL_LABEL[channel.kind]}.`} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={busy} disabledReason={!text.trim() ? 'Write a message' : null} onClick={async () => {
        setBusy(true);
        try { await api.post(`/api/inbox/channels/${channel.id}/simulate`, { kind, text: text.trim(), ...(name.trim() ? { name: name.trim() } : {}), ...(kind === 'review' ? { rating } : {}), ...(canAttach && attachment ? { attachment: true } : {}) }); toast.success('Simulated message received'); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); }
      }}>Receive</Button>
    </>}>
      <div className="flex flex-col gap-3">
        {kinds.length > 1 ? <Field label="Type"><Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>{kinds.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select></Field> : null}
        <Field label="Customer name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Simulated customer" /></Field>
        {kind === 'review' ? <Field label="Rating"><Select value={String(rating)} onChange={(e) => setRating(Number(e.target.value))}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{'★'.repeat(n)} ({n})</option>)}</Select></Field> : null}
        <Field label="Message"><Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} /></Field>
        {canAttach ? <Checkbox label="Include an attachment" checked={attachment} onChange={(e) => setAttachment(e.target.checked)} /> : null}
      </div>
    </Dialog>
  );
}
