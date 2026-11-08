'use client';
// Approve an MCP client for the current workspace: which scopes and which brands. Only the person the client acts for
// sees this; approving needs step-up (the API answers step_up_required → verify → return here).
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bot } from 'lucide-react';
import { MCP_DEFAULT_SCOPES, MCP_SCOPE_LABEL, type McpClientView, type McpScope } from '@social-lite/core/contracts/mcp';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Banner, Button, Card, CardHeader, Checkbox, ErrorNotice, ErrorState, RadioGroup, Skeleton, useToast } from '@/components/ui';
import { ClientStatusBadge } from './shared';

interface ConsentData { client: McpClientView; brands: Array<{ id: string; name: string }>; scopes: McpScope[]; workspace_id: string }

export function McpConsentPanel({ clientRowId, onDone }: { clientRowId: string; onDone?: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<ConsentData>(`/api/mcp/clients/${clientRowId}`);
  const [scopes, setScopes] = useState<McpScope[]>([]);
  const [mode, setMode] = useState<'all' | 'some'>('all');
  const [brands, setBrands] = useState<string[]>([]);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => {
    if (!data) return;
    const c = data.client;
    setScopes(c.status === 'active' ? c.granted_scopes : (c.requested_scopes.length ? c.requested_scopes : MCP_DEFAULT_SCOPES));
    setMode(c.brands ? 'some' : 'all');
    setBrands(c.brands?.map((b) => b.id) ?? []);
  }, [data]);

  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data) return <Skeleton className="h-64 w-full max-w-2xl rounded-xl" />;
  const c = data.client;
  const done = () => (onDone ? onDone() : router.push('/mcp/settings'));
  const approve = async () => {
    setBusy('approve'); setErr(null);
    try {
      await api.post(`/api/mcp/clients/${c.id}/consent`, { scopes, brand_ids: mode === 'all' ? null : brands });
      toast.success('Client approved');
      done();
    } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const deny = async () => {
    setBusy('deny'); setErr(null);
    try { await api.post(`/api/mcp/clients/${c.id}/revoke`, { reason: 'Denied at consent' }); toast.success('Denied'); done(); }
    catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const publishing = scopes.some((s) => s.startsWith('publishing.'));
  return (
    <Card className="max-w-2xl" data-testid="mcp-consent">
      <CardHeader title={<span className="flex items-center gap-2"><Bot aria-hidden className="size-4 text-accent" />{c.name}<ClientStatusBadge status={c.status} /></span>} />
      <div className="flex flex-col gap-5 px-4 pb-4">
        <p className="text-xs text-muted"><code className="font-mono">{c.client_id}</code> · acts as you in this workspace</p>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px] font-medium">Allow</legend>
          {data.scopes.map((s) => (
            <Checkbox key={s} label={<span><code className="font-mono text-[12px]">{s}</code> <span className="text-muted">· {MCP_SCOPE_LABEL[s]}</span>{c.requested_scopes.includes(s) ? '' : <span className="text-muted"> · not requested</span>}</span>}
              checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...new Set([...scopes, s])] : scopes.filter((x) => x !== s))} />
          ))}
        </fieldset>
        {publishing ? <Banner tone="info">Each publication still needs your confirmation in Relay unless you add an automation policy.</Banner> : null}
        <RadioGroup legend="Brands" name="mcp-brands" value={mode} onChange={setMode} options={[{ value: 'all', label: 'All brands I can access' }, { value: 'some', label: 'Selected brands' }]} />
        {mode === 'some' ? (
          <div className="flex flex-col gap-1.5 pl-1">
            {data.brands.map((b) => <Checkbox key={b.id} label={b.name} checked={brands.includes(b.id)} onChange={(e) => setBrands(e.target.checked ? [...brands, b.id] : brands.filter((x) => x !== b.id))} />)}
          </div>
        ) : null}
        {err ? <ErrorNotice error={err} /> : null}
        <div className="flex flex-wrap justify-end gap-2">
          {c.status !== 'revoked' ? <Button variant="ghost" onClick={deny} loading={busy === 'deny'} disabled={!!busy}>{c.status === 'pending' ? 'Deny' : 'Revoke'}</Button> : null}
          <Button variant="primary" onClick={approve} loading={busy === 'approve'} disabled={!!busy} data-testid="mcp-approve"
            disabledReason={!scopes.length ? 'Choose at least one scope' : mode === 'some' && !brands.length ? 'Choose a brand' : null}>
            {c.status === 'active' ? 'Save' : 'Approve'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
