'use client';
// Settings → Developer → MCP. Endpoint + setup (generated server-side from the live routing/config), connected
// clients (scopes, brands, last activity, revoke), automation policies and the MCP audit trail.
// Exported for the Settings navigation (redesign stream); also mounted at /mcp/settings.
import { useState } from 'react';
import Link from 'next/link';
import { Bot, Cable, ScrollText, ShieldCheck } from 'lucide-react';
import type { McpAuditView, McpClientView, McpOverview, McpSetupInfo } from '@social-lite/core/contracts/mcp';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { fmtRelative } from '@/lib/client/format';
import {
  Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorState, Facts, Segmented, Skeleton, Table, THead, Th, Td, Tr, buttonClass, useToast,
} from '@/components/ui';
import { ClientStatusBadge, CopyValue, ScopeChips } from './shared';
import { McpPolicyGrants } from './policy-grants';

export function McpDeveloperSettings() {
  const { data, error, loading, refetch } = useApi<McpOverview>('/api/mcp');
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data) return <Skeleton className="h-64 w-full max-w-4xl rounded-xl" />;
  return (
    <div className="flex max-w-4xl flex-col gap-4" data-testid="mcp-settings">
      <McpEndpointCard setup={data.setup} />
      <McpClientsList clients={data.clients} onChanged={refetch} />
      <McpPolicyGrants clients={data.clients} />
      <McpSetupGuide setup={data.setup} />
      <McpAuditList />
    </div>
  );
}

export function McpEndpointCard({ setup }: { setup: McpSetupInfo }) {
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Cable aria-hidden className="size-4 text-accent" />Endpoint</span>} />
      <div className="flex flex-col gap-3 px-4 pb-4">
        <CopyValue value={setup.endpoint} label="endpoint URL" />
        <Facts items={[
          ['Protocol', <code key="p" className="font-mono text-[12px]">{setup.protocol_version}</code>],
          ['SDK', <code key="s" className="font-mono text-[12px]">@modelcontextprotocol/sdk {setup.sdk_version}</code>],
          ['Sign-in', setup.authorization_server ?? 'Not configured'],
          ['OAuth client', setup.preregistered_client_id ?? '—'],
        ]} />
      </div>
    </Card>
  );
}

export function McpSetupGuide({ setup }: { setup: McpSetupInfo }) {
  const [id, setId] = useState(setup.examples[0]?.id ?? '');
  const ex = setup.examples.find((e) => e.id === id) ?? setup.examples[0];
  return (
    <Card>
      <CardHeader title="Connect a client" />
      <div className="flex flex-col gap-3 px-4 pb-4">
        <Segmented label="Client" size="sm" value={id} onChange={setId} options={setup.examples.map((e) => ({ value: e.id, label: e.label }))} className="max-w-full overflow-x-auto" />
        {ex ? <CopyValue value={ex.body} label={ex.label} multiline /> : null}
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border" aria-label="Scopes">
          {setup.scopes.map((s) => (
            <li key={s.scope} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px]">
              <code className="font-mono text-[12px]">{s.scope}</code>
              <span className="text-muted">{s.label}{setup.default_scopes.includes(s.scope) ? ' · default' : ''}</span>
            </li>
          ))}
        </ul>
        <Table caption="Client compatibility">
          <THead><tr><Th>Client</Th><Th>Status</Th><Th className="hidden sm:table-cell">Notes</Th></tr></THead>
          <tbody>
            {setup.tested_clients.map((c) => (
              <Tr key={c.client}>
                <Td className="text-[13px]">{c.client}</Td>
                <Td><Badge tone={c.status === 'tested' ? 'success' : c.status === 'unsupported' ? 'danger' : 'neutral'}>{c.status === 'not_tested' ? 'Not tested' : c.status === 'tested' ? 'Tested' : 'Unsupported'}</Badge></Td>
                <Td className="hidden text-xs text-muted sm:table-cell">{c.notes}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
    </Card>
  );
}

export function McpClientsList({ clients, onChanged }: { clients: McpClientView[]; onChanged: () => unknown }) {
  const toast = useToast();
  const [revoke, setRevoke] = useState<McpClientView | null>(null);
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Bot aria-hidden className="size-4 text-accent" />Connected clients</span>} />
      {clients.length === 0 ? (
        <div className="px-4 pb-4"><EmptyState compact icon={<Bot aria-hidden />} title="No clients yet" /></div>
      ) : (
        <ul className="divide-y divide-border" data-testid="mcp-clients">
          {clients.map((c) => (
            <li key={c.id} className="flex flex-col gap-2 px-4 py-3" data-client-id={c.client_id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {c.name}<ClientStatusBadge status={c.status} />{c.kind === 'api_key' ? <Badge>API key</Badge> : null}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    <code className="font-mono">{c.client_id}</code>
                    {!c.is_mine ? ` · ${c.owner.name ?? c.owner.email}` : ''}
                    {' · '}{c.last_activity_at ? `used ${fmtRelative(c.last_activity_at)}${c.last_tool ? ` (${c.last_tool})` : ''}` : 'never used'}
                    {' · '}{c.brands ? c.brands.map((b) => b.name).join(', ') : 'all brands'}
                  </p>
                </div>
                <div className="flex gap-2">
                  {c.status === 'pending' && c.is_mine ? <Link href={`/mcp/connect/${c.id}`} className={buttonClass('primary', 'sm')}>Review</Link> : null}
                  {c.status === 'revoked' && c.is_mine && c.kind === 'oauth' ? <Link href={`/mcp/connect/${c.id}`} className={buttonClass('secondary', 'sm')}>Allow again</Link> : null}
                  {c.status === 'active' && c.is_mine && c.kind === 'oauth' ? <Link href={`/mcp/connect/${c.id}`} className={buttonClass('quiet', 'sm')}>Edit</Link> : null}
                  {c.can_revoke ? <Button size="sm" variant="danger" onClick={() => setRevoke(c)}>Revoke</Button> : null}
                </div>
              </div>
              <ScopeChips scopes={c.status === 'pending' ? c.requested_scopes : c.granted_scopes} />
            </li>
          ))}
        </ul>
      )}
      {revoke ? (
        <ConfirmDialog open onOpenChange={(o) => { if (!o) setRevoke(null); }} title={`Revoke ${revoke.name}?`} confirmLabel="Revoke" confirmVariant="danger"
          onConfirm={async () => { await api.post(`/api/mcp/clients/${revoke.id}/revoke`, {}); toast.success('Revoked'); await onChanged(); }} />
      ) : null}
    </Card>
  );
}

interface AuditPage { items: McpAuditView[]; next_cursor: string | null; scope: 'workspace' | 'mine' }

export function McpAuditList({ clientRowId }: { clientRowId?: string }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'problems'>('all');
  const q = new URLSearchParams({ limit: '50', ...(clientRowId ? { client_row_id: clientRowId } : {}), ...(cursor ? { cursor } : {}) });
  const { data, error, loading, refetch } = useApi<AuditPage>(`/api/mcp/audit?${q.toString()}`, { keepPrevious: true });
  const items = (data?.items ?? []).filter((a) => filter === 'all' || a.result !== 'ok');
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><ScrollText aria-hidden className="size-4 text-accent" />Activity</span>}
        actions={<Segmented label="Filter" size="sm" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'problems', label: 'Denied & errors' }]} />} />
      {error && !data ? <div className="px-4 pb-4"><ErrorState error={error} onRetry={refetch} /></div>
        : loading && !data ? <div className="px-4 pb-4"><Skeleton className="h-32 w-full" /></div>
        : !items.length ? <div className="px-4 pb-4"><EmptyState compact icon={<ShieldCheck aria-hidden />} title="No activity" /></div>
        : (
          <div className="px-2 pb-2">
            <Table caption="MCP activity">
              <THead><tr><Th>When</Th><Th>Tool</Th><Th>Result</Th><Th className="hidden md:table-cell">Client</Th><Th className="hidden lg:table-cell">Ref</Th></tr></THead>
              <tbody>
                {items.map((a) => (
                  <Tr key={a.id}>
                    <Td className="text-xs text-muted whitespace-nowrap">{fmtRelative(a.created_at)}</Td>
                    <Td><code className="font-mono text-[12px]">{a.tool}</code></Td>
                    <Td><Badge tone={a.result === 'ok' ? 'success' : a.result === 'denied' ? 'warn' : a.result === 'cancelled' ? 'neutral' : 'danger'}>{a.result}{a.error_code ? ` · ${a.error_code}` : ''}</Badge></Td>
                    <Td className="hidden text-xs md:table-cell">{a.client.name ?? a.client.client_id ?? '—'}{data?.scope === 'workspace' && a.actor.email ? ` · ${a.actor.email}` : ''}</Td>
                    <Td className="hidden font-mono text-[11px] text-muted lg:table-cell">{a.correlation_id.slice(0, 8)} · {a.latency_ms} ms</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <div className="flex justify-end gap-2 px-2 py-2">
              {cursor ? <Button size="sm" variant="quiet" onClick={() => setCursor(null)}>Newest</Button> : null}
              {data?.next_cursor ? <Button size="sm" onClick={() => setCursor(data.next_cursor)}>Older</Button> : null}
            </div>
          </div>
        )}
    </Card>
  );
}

