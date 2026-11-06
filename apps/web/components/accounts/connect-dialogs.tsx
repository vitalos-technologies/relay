'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PROVIDER_LABEL, type Provider } from '@social-lite/core';
import { api, isApiError } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import type { Connection, MockScenario, ProviderStatus } from '@/lib/client/types';
import { Banner, Button, Dialog, ErrorNotice, Field, Input, PlatformIcon, Select } from '@/components/ui';

export const MOCK_SCENARIO_LABEL: Record<MockScenario, string> = {
  success: 'Always succeeds',
  fail_permanent: 'Rejects the post (permanent failure)',
  fail_transient_once: 'Temporary error once, then succeeds',
  timeout_after_send: 'Posts but the response is lost (Unknown)',
  rate_limited_once: 'Rate limited once, then succeeds',
  processing: 'Slow processing, then succeeds',
  revoked: 'Access revoked (reconnect required)',
  missing_permission: 'Missing publish permission',
};
export const MOCK_SCENARIOS = Object.keys(MOCK_SCENARIO_LABEL) as MockScenario[];

/** Explains a provider whose app credentials are not configured, pointing owners to Setup. */
export function NotConfiguredDialog({ provider, status, open, onOpenChange }: { provider: Provider | null; status?: ProviderStatus; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { can } = useSession();
  if (!provider) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${PROVIDER_LABEL[provider]} isn’t set up yet`}
      description="Connecting accounts needs the app credentials for this network to be configured for Social Lite first."
      footer={
        can('setup.manage') ? (
          <Link href="/setup" className="touch-target inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-sm font-medium text-on-accent hover:bg-accent-hover">Open Setup</Link>
        ) : <Button onClick={() => onOpenChange(false)}>Close</Button>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        {status?.missing?.length ? (
          <p>Missing: {status.missing.map((m) => <code key={m} className="mr-1.5 rounded bg-raised px-1.5 py-0.5 font-mono text-[11px]">{m}</code>)}</p>
        ) : null}
        {status?.notes ? <p className="text-muted">{status.notes}</p> : null}
        {can('setup.manage') ? <p>As the workspace owner, you can add these in Setup.</p> : <p>Ask the workspace owner to configure {PROVIDER_LABEL[provider]} in Setup.</p>}
      </div>
    </Dialog>
  );
}

export function TelegramDialog({
  open, onOpenChange, brandId, reconnect, onDone,
}: { open: boolean; onOpenChange: (o: boolean) => void; brandId: string; reconnect?: Connection | null; onDone: (c: Connection) => void }) {
  const [token, setToken] = useState('');
  const [channel, setChannel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!open) {
      setToken('');
      setChannel('');
      setError(null);
    }
  }, [open]);
  const channelBad = !reconnect && channel.trim() !== '' && !/^(@[A-Za-z0-9_]{4,}|-100\d{5,})$/.test(channel.trim());
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = reconnect
        ? await api.post<Connection>(`/api/connections/${reconnect.id}/reconnect`, { bot_token: token.trim() })
        : await api.post<Connection>(`/api/brands/${brandId}/connections/telegram`, { bot_token: token.trim(), channel: channel.trim() });
      setToken('');
      onDone(c);
      onOpenChange(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const fe = isApiError(error) ? error.fieldErrors : undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      size="md"
      title={reconnect ? `Reconnect ${reconnect.display_name}` : 'Connect a Telegram channel'}
      description="We verify the bot and its posting rights before the channel is marked Ready."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabledReason={!token.trim() ? 'Enter the bot token.' : !reconnect && !channel.trim() ? 'Enter the channel.' : channelBad ? 'Fix the channel format.' : null}>
            {busy ? 'Verifying…' : reconnect ? 'Verify and reconnect' : 'Verify and connect'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ol className="list-decimal space-y-1 rounded-lg border border-border bg-sunken py-3 pl-8 pr-4 text-[13px] text-muted">
          <li>Create a bot with <span className="text-fg">@BotFather</span> (a dedicated bot is best) and copy its token.</li>
          <li>Add the bot to your channel as an <span className="text-fg">administrator</span> with <span className="text-fg">“Post messages”</span> enabled.</li>
          <li>Enter the token and the channel’s public @username or numeric ID below.</li>
        </ol>
        <Field label="Bot token" hint="Sent once over a protected connection and stored encrypted. It is never shown again." error={fe?.bot_token}>
          <Input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456789:AA…" />
        </Field>
        {!reconnect ? (
          <Field label="Channel" hint="@channelname, or the numeric ID starting with -100" error={fe?.channel ?? (channelBad ? 'Use @name (at least 4 characters) or -100… ID.' : null)}>
            <Input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="@yourchannel" autoComplete="off" spellCheck={false} />
          </Field>
        ) : null}
        <p className="text-xs text-muted">Social Lite only sends messages. It does not change the bot’s webhook or read its updates, so existing bot integrations keep working.</p>
        {error && !fe ? <ErrorNotice error={error} /> : null}
      </div>
    </Dialog>
  );
}

export function MockDialog({ open, onOpenChange, brandId, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; brandId: string; onDone: (c: Connection) => void }) {
  const [provider, setProvider] = useState<Provider>('instagram');
  const [name, setName] = useState('');
  const [scenario, setScenario] = useState<MockScenario>('success');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await api.post<Connection>(`/api/brands/${brandId}/connections/mock`, { provider, display_name: name.trim(), scenario });
      onDone(c);
      onOpenChange(false);
      setName('');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      title="Add simulated destination"
      description="Simulated destinations behave like the real network’s API but never post anything. Results are always labelled “Simulated”."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabledReason={!name.trim() ? 'Enter a display name.' : null}>Add simulated destination</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Network">
          <Select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
            {(['instagram', 'facebook', 'telegram', 'x'] as Provider[]).map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
          </Select>
        </Field>
        <Field label="Display name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`Demo ${PROVIDER_LABEL[provider]}`} maxLength={80} /></Field>
        <Field label="Behaviour" hint="Use failure scenarios to rehearse how your team handles problems.">
          <Select value={scenario} onChange={(e) => setScenario(e.target.value as MockScenario)}>
            {MOCK_SCENARIOS.map((s) => <option key={s} value={s}>{MOCK_SCENARIO_LABEL[s]}</option>)}
          </Select>
        </Field>
        <div className="flex items-center gap-2 text-xs text-muted"><PlatformIcon provider={provider} size="xs" decorative /> Will appear with a “Simulated” label everywhere.</div>
        {error ? <ErrorNotice error={error} /> : null}
      </div>
    </Dialog>
  );
}

export function DisconnectBlockedBanner({ count }: { count: number }) {
  if (!count) return null;
  return <Banner tone="warn">{count} scheduled deliver{count === 1 ? 'y was' : 'ies were'} blocked. Reconnect this destination or remove it from those posts.</Banner>;
}
