'use client';
// Settings → Sources: Google Drive & Docs and Notion content connections (separate from sign-in and social accounts).
// Exported for the redesigned left Settings navigation. Connect/reconnect/disconnect, writeback opt-in, change watch.
import { useState } from 'react';
import { CircleAlert, CircleCheck, Plug, RefreshCw, Unplug } from 'lucide-react';
import type { ContentConnectionDto, ContentHubSourceStatus, ContentSource } from '@social-lite/core/contracts/content-hub';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useQueryState } from '@/lib/client/hooks';
import { useSession } from '@/lib/client/session';
import { fmtRelative } from '@/lib/client/format';
import { Badge, Banner, Button, Card, CardHeader, ConfirmDialog, ErrorNotice, ErrorState, LinkButton, Select, SkeletonRows, Switch, useToast } from '@/components/ui';

const LABEL: Record<ContentSource, string> = { google: 'Google Drive & Docs', notion: 'Notion' };
const ERRORS: Record<string, string> = {
  access_denied: 'Access was not granted.', scope_denied: 'Relay needs “files you choose” access to Drive.', session_mismatch: 'Finish connecting in the same browser session.',
  invalid_state: 'The connection request expired. Try again.', forbidden: 'You no longer have permission to connect sources.', token_exchange_failed: 'Couldn’t connect. Try again.',
  not_configured: 'Not set up yet.', account_mismatch: 'Reconnect with the same account.',
};

function StatusBadge({ c }: { c: ContentConnectionDto }) {
  if (c.status === 'active') return <Badge tone="success" icon={<CircleCheck aria-hidden className="size-3.5" />}>{c.is_test ? 'Test data' : 'Connected'}</Badge>;
  if (c.status === 'reconnect_required') return <Badge tone="warn" icon={<CircleAlert aria-hidden className="size-3.5" />} title={c.status_detail ?? undefined}>Reconnect</Badge>;
  return <Badge icon={<Unplug aria-hidden className="size-3.5" />}>Disconnected</Badge>;
}

function SourceBlock({ status, connections, onChanged }: { status: ContentHubSourceStatus; connections: ContentConnectionDto[]; onChanged: () => void }) {
  const { session, can, canV2 } = useSession();
  const toast = useToast();
  const owner = can('setup.manage');
  const [scope, setScope] = useState<string>(session.brands[0]?.id ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [disc, setDisc] = useState<ContentConnectionDto | null>(null);
  const manage = canV2('connections.manage');
  const start = async (reconnect?: ContentConnectionDto) => {
    setBusy(reconnect?.id ?? 'new'); setErr(null);
    try {
      const r = await api.post<{ authorization_url: string }>('/api/content-hub/connections/start', {
        source: status.source, brand_id: reconnect ? reconnect.brand_id : scope || null, reconnect_connection_id: reconnect?.id ?? null,
      });
      window.location.assign(r.authorization_url);
    } catch (e) { setErr(e); setBusy(null); }
  };
  const testConnect = async () => {
    setBusy('test'); setErr(null);
    try { await api.post('/api/content-hub/connections/test', { source: status.source, brand_id: scope || null }); onChanged(); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const toggleWriteback = async (c: ContentConnectionDto, enabled: boolean) => {
    try { await api.post(`/api/content-hub/connections/${c.id}/writeback`, { enabled }); onChanged(); } catch (e) { toast.error(e); }
  };
  const watch = async (c: ContentConnectionDto) => {
    try { await api.post(`/api/content-hub/connections/${c.id}/watch`, {}); toast.success('Change notifications on'); } catch (e) { toast.error(e); }
  };
  return (
    <Card aria-labelledby={`src-${status.source}`}>
      <CardHeader id={`src-${status.source}`} title={LABEL[status.source]} />
      <div className="flex flex-col gap-4 p-4 pt-0">
        {!status.configured ? (
          <Banner tone="info" title="Not set up" actions={owner ? <LinkButton size="sm" href="/setup">Setup</LinkButton> : null}>
            {owner ? <>Add {status.missing.join(', ')} in Setup.</> : 'An owner can set this up.'}
          </Banner>
        ) : null}
        {status.source === 'google' && status.configured && !status.picker_configured ? (
          <Banner tone="warn" title="File picker not set up">{owner ? 'Add GOOGLE_PICKER_API_KEY and GOOGLE_PICKER_APP_ID in Setup.' : 'An owner can set this up.'}</Banner>
        ) : null}
        <ul className="flex flex-col divide-y divide-border">
          {connections.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{c.account_label}</p>
                <p className="text-xs text-muted">
                  {c.scope === 'workspace' ? 'All brands' : session.brands.find((b) => b.id === c.brand_id)?.name ?? 'Brand'} · {c.item_count} items
                  {c.last_used_at ? ` · used ${fmtRelative(c.last_used_at)}` : ''}{c.authorized_by ? ` · by ${c.authorized_by}` : ''}
                </p>
              </div>
              <StatusBadge c={c} />
              {c.source === 'notion' && c.status === 'active' && c.can_manage ? (
                <Switch label="Writeback" checked={c.writeback_enabled} onCheckedChange={(v) => toggleWriteback(c, v)} />
              ) : null}
              {c.source === 'google' && c.status === 'active' && c.can_manage && !c.is_test ? <Button size="sm" variant="ghost" onClick={() => watch(c)}>Watch changes</Button> : null}
              {c.can_manage && c.status === 'reconnect_required' && !c.is_test ? <Button size="sm" icon={<RefreshCw aria-hidden className="size-4" />} onClick={() => start(c)} loading={busy === c.id}>Reconnect</Button> : null}
              {c.can_manage && c.status !== 'disconnected' ? <Button size="sm" variant="ghost" onClick={() => setDisc(c)}>Disconnect</Button> : null}
            </li>
          ))}
        </ul>
        {manage ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Scope" className="w-[220px]" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">All brands (workspace)</option>
              {session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
            <Button variant="primary" icon={<Plug aria-hidden className="size-4" />} onClick={() => start()} loading={busy === 'new'} disabledReason={status.configured ? null : 'Not set up'}>Connect</Button>
            {status.test_mode_available ? <Button variant="ghost" onClick={testConnect} loading={busy === 'test'}>Use test data</Button> : null}
          </div>
        ) : null}
        {err ? <ErrorNotice error={err} /> : null}
      </div>
      <ConfirmDialog open={!!disc} onOpenChange={(o) => !o && setDisc(null)} title={`Disconnect ${disc?.account_label ?? ''}?`} confirmVariant="danger" confirmLabel="Disconnect"
        description="Stops refresh, change notifications and writeback, and hides source previews. Imported copies stay in Relay under your retention policy."
        onConfirm={async () => { await api.post(`/api/content-hub/connections/${disc!.id}/disconnect`, {}); onChanged(); }} />
    </Card>
  );
}

/** Settings content for Google Drive & Docs + Notion sources. */
/** Settings → Connections → Google Drive and Docs / Notion. `source` shows one provider's page; omitted shows both. */
export function SourceConnectionsSettings({ source }: { source?: 'google' | 'notion' } = {}) {
  const [params] = useQueryState();
  const status = useApi<ContentHubSourceStatus[]>('/api/content-hub/status');
  const conns = useApi<ContentConnectionDto[]>('/api/content-hub/connections');
  if ((status.error && !status.data) || (conns.error && !conns.data)) return <ErrorState error={status.error ?? conns.error} onRetry={() => { void status.refetch(); void conns.refetch(); }} />;
  if (!status.data || !conns.data) return <SkeletonRows rows={6} />;
  const error = params.get('error');
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      {error ? <Banner tone="danger" title={ERRORS[error] ?? 'Couldn’t connect. Try again.'} /> : null}
      {params.get('connected') ? <Banner tone="success" title="Connected" /> : null}
      <p className="text-[13px] text-muted">Relay only reads items you pick. Imports are private copies; source sharing is never changed.</p>
      {status.data.filter((s) => !source || s.source === source).map((s) => <SourceBlock key={s.source} status={s} connections={conns.data!.filter((c) => c.source === s.source)} onChanged={() => void conns.refetch()} />)}
    </div>
  );
}
