'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PROVIDER_LABEL, type Provider } from '@social-lite/core';
import { api, isApiError } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import type { Connection, MockScenario, ProviderStatus } from '@/lib/client/types';
import { Banner, Button, buttonClass, Dialog, ErrorNotice, Field, Input, Select } from '@/components/ui';

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
      title={`${PROVIDER_LABEL[provider]} isn’t set up`}
      footer={
        can('setup.manage') ? (
          <Link href="/setup" className={buttonClass('primary')}>Open Setup</Link>
        ) : <Button onClick={() => onOpenChange(false)}>Close</Button>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        {status?.missing?.length ? (
          <p>Missing: {status.missing.map((m) => <code key={m} className="mr-1.5 rounded bg-raised px-1.5 py-0.5 font-mono text-[11px]">{m}</code>)}</p>
        ) : null}
        {status?.notes ? <p className="text-muted">{status.notes}</p> : null}
        {can('setup.manage') ? null : <p className="text-muted">Ask the workspace owner.</p>}
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
      title={reconnect ? `Reconnect ${reconnect.display_name}` : 'Connect Telegram'}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabledReason={!token.trim() ? 'Enter the bot token.' : !reconnect && !channel.trim() ? 'Enter the channel.' : channelBad ? 'Fix the channel format.' : null}>
            {busy ? 'Verifying…' : reconnect ? 'Reconnect' : 'Connect'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted">
          <li>Create a bot with <span className="text-fg">@BotFather</span>.</li>
          <li>Make it a channel <span className="text-fg">admin</span> with <span className="text-fg">“Post messages”</span>.</li>
        </ol>
        <Field label="Bot token" hint="Stored encrypted. Never shown again." error={fe?.bot_token}>
          <Input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456789:AA…" />
        </Field>
        {!reconnect ? (
          <Field label="Channel" hint="@name or -100… ID" error={fe?.channel ?? (channelBad ? 'Use @name (4+ chars) or -100… ID.' : null)}>
            <Input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="@yourchannel" autoComplete="off" spellCheck={false} />
          </Field>
        ) : null}
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
      title="Simulated destination"
      description="Never posts. Always labelled “Simulated”."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabledReason={!name.trim() ? 'Enter a name.' : null}>Add</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Network">
          <Select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
            {(['instagram', 'facebook', 'telegram', 'x'] as Provider[]).map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
          </Select>
        </Field>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`Demo ${PROVIDER_LABEL[provider]}`} maxLength={80} /></Field>
        <Field label="Behaviour">
          <Select value={scenario} onChange={(e) => setScenario(e.target.value as MockScenario)}>
            {MOCK_SCENARIOS.map((s) => <option key={s} value={s}>{MOCK_SCENARIO_LABEL[s]}</option>)}
          </Select>
        </Field>
        {error ? <ErrorNotice error={error} /> : null}
      </div>
    </Dialog>
  );
}

export function DisconnectBlockedBanner({ count }: { count: number }) {
  if (!count) return null;
  return <Banner tone="warn">{count} scheduled deliver{count === 1 ? 'y' : 'ies'} blocked. Reconnect or remove it.</Banner>;
}
