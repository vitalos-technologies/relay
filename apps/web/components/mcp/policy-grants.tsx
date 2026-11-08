'use client';
// Automation policies: pre-authorise one of MY approved MCP clients to commit publications without a per-intent
// confirmation, within brand / destination / time-window / content limits. Created with step-up (the API answers
// step_up_required → verify → return); revocable at any time. Everything outside a policy still needs confirmation.
import { useMemo, useState } from 'react';
import { Plus, Timer } from 'lucide-react';
import type { McpClientView, McpPolicyGrantView } from '@social-lite/core/contracts/mcp';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import type { Brand, Connection } from '@/lib/client/types';
import {
  Badge, Button, Card, CardHeader, Checkbox, ConfirmDialog, Dialog, EmptyState, ErrorNotice, ErrorState, Field, Input, Select, Skeleton, useToast,
} from '@/components/ui';

export function McpPolicyGrants({ clients }: { clients: McpClientView[] }) {
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<{ items: McpPolicyGrantView[] }>('/api/mcp/policies');
  const [open, setOpen] = useState(false);
  const [revoke, setRevoke] = useState<McpPolicyGrantView | null>(null);
  const eligible = clients.filter((c) => c.is_mine && c.kind === 'oauth' && c.status === 'active'
    && (c.granted_scopes.includes('publishing.schedule') || c.granted_scopes.includes('publishing.publish')));
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Timer aria-hidden className="size-4 text-accent" />Automation policies</span>}
        actions={<Button size="sm" icon={<Plus aria-hidden className="size-4" />} onClick={() => setOpen(true)} disabledReason={eligible.length ? null : 'Approve a client with a publishing scope first'}>New</Button>} />
      {error && !data ? <div className="px-4 pb-4"><ErrorState error={error} onRetry={refetch} /></div>
        : loading || !data ? <div className="px-4 pb-4"><Skeleton className="h-16 w-full" /></div>
        : !data.items.length ? <div className="px-4 pb-4"><EmptyState compact icon={<Timer aria-hidden />} title="Every publication needs confirmation" /></div>
        : (
          <ul className="divide-y divide-border" data-testid="mcp-policies">
            {data.items.map((g) => (
              <li key={g.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">{g.client_name} → {g.brand.name}
                    <Badge tone={g.status === 'active' ? 'success' : g.status === 'scheduled' ? 'info' : 'neutral'}>{g.status}</Badge>
                    {g.allow_immediate ? <Badge tone="warn">Publish now</Badge> : null}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {g.max_per_day}/day · up to {g.max_days_ahead} days ahead · {String(g.local_start_hour).padStart(2, '0')}:00–{String(g.local_end_hour).padStart(2, '0')}:00
                    {' · '}{g.connection_ids ? `${g.connection_ids.length} destination${g.connection_ids.length === 1 ? '' : 's'}` : 'all destinations'}
                    {g.allow_links ? '' : ' · no links'}{g.allow_media ? '' : ' · no media'}{g.max_text_length ? ` · ≤${g.max_text_length} chars` : ''}
                    {' · until '}{new Date(g.valid_until).toLocaleDateString()}
                  </p>
                </div>
                {!g.revoked_at ? <Button size="sm" variant="danger" onClick={() => setRevoke(g)}>Revoke</Button> : null}
              </li>
            ))}
          </ul>
        )}
      {open ? <PolicyDialog clients={eligible} onClose={() => setOpen(false)} onCreated={async () => { setOpen(false); toast.success('Policy created'); await refetch(); }} /> : null}
      {revoke ? (
        <ConfirmDialog open onOpenChange={(o) => { if (!o) setRevoke(null); }} title="Revoke policy?" confirmLabel="Revoke" confirmVariant="danger"
          onConfirm={async () => { await api.post(`/api/mcp/policies/${revoke.id}/revoke`, {}); toast.success('Revoked'); await refetch(); }} />
      ) : null}
    </Card>
  );
}

function PolicyDialog({ clients, onClose, onCreated }: { clients: McpClientView[]; onClose: () => void; onCreated: () => Promise<void> }) {
  const brands = useApi<{ items: Brand[] }>('/api/brands');
  const [clientId, setClientId] = useState(clients[0]?.id ?? '');
  const client = clients.find((c) => c.id === clientId);
  const brandChoices = useMemo(() => (brands.data?.items ?? []).filter((b) => !client?.brands || client.brands.some((x) => x.id === b.id)), [brands.data, client]);
  const [brandId, setBrandId] = useState('');
  const effectiveBrand = brandId || brandChoices[0]?.id || '';
  const conns = useApi<{ items: Connection[] }>(effectiveBrand ? `/api/brands/${effectiveBrand}/connections` : null);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [days, setDays] = useState(7);
  const [perDay, setPerDay] = useState(3);
  const [start, setStart] = useState(8);
  const [end, setEnd] = useState(20);
  const [immediate, setImmediate] = useState(false);
  const [links, setLinks] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const canNow = !!client?.granted_scopes.includes('publishing.publish');
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/api/mcp/policies', {
        client_row_id: clientId, brand_id: effectiveBrand, connection_ids: selected && selected.length ? selected : null, allow_immediate: immediate && canNow,
        valid_until: new Date(Date.now() + days * 86_400_000).toISOString(), max_per_day: perDay, local_start_hour: start, local_end_hour: end, allow_links: links,
      });
      await onCreated();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title="New automation policy" busy={busy}
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={submit} loading={busy} disabledReason={!clientId ? 'Choose a client' : !effectiveBrand ? 'Choose a brand' : null}>Create</Button></>}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Client"><Select value={clientId} onChange={(e) => setClientId(e.target.value)}>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <Field label="Brand"><Select value={effectiveBrand} onChange={(e) => { setBrandId(e.target.value); setSelected(null); }}>{brandChoices.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        </div>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[13px] font-medium">Destinations</legend>
          {conns.loading ? <Skeleton className="h-8 w-full" /> : (conns.data?.items ?? []).filter((c) => !c.disconnected_at).map((c) => (
            <Checkbox key={c.id} label={`${c.display_name} · ${c.provider}${c.is_mock ? ' (simulated)' : ''}`} checked={selected === null || selected.includes(c.id)}
              onChange={(e) => {
                const all = (conns.data?.items ?? []).map((x) => x.id);
                const cur = selected ?? all;
                setSelected(e.target.checked ? [...new Set([...cur, c.id])] : cur.filter((x) => x !== c.id));
              }} />
          ))}
        </fieldset>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Days valid"><Input type="number" min={1} max={90} value={days} onChange={(e) => setDays(Math.min(90, Math.max(1, Number(e.target.value) || 1)))} /></Field>
          <Field label="Per day"><Input type="number" min={1} max={50} value={perDay} onChange={(e) => setPerDay(Math.min(50, Math.max(1, Number(e.target.value) || 1)))} /></Field>
          <Field label="From hour"><Input type="number" min={0} max={23} value={start} onChange={(e) => setStart(Math.min(23, Math.max(0, Number(e.target.value) || 0)))} /></Field>
          <Field label="To hour"><Input type="number" min={1} max={24} value={end} onChange={(e) => setEnd(Math.min(24, Math.max(1, Number(e.target.value) || 1)))} /></Field>
        </div>
        <Checkbox label="Allow links" checked={links} onChange={(e) => setLinks(e.target.checked)} />
        {canNow ? <Checkbox label="Allow publish now" checked={immediate} onChange={(e) => setImmediate(e.target.checked)} /> : null}
        {err ? <ErrorNotice error={err} /> : null}
      </div>
    </Dialog>
  );
}
