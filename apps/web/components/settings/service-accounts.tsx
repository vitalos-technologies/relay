'use client';
// Settings → Service accounts (owner/admin). Machine principals with a named owner, expiry and ONE brand-scoped
// grant (create drafts / read / edit). Keys are shown once; only their prefix is listed afterwards.
// Creating accounts and keys needs a fresh verification (the API answers step_up_required → verify → return).
import { useState } from 'react';
import { Bot, Copy, KeyRound, Plus, RotateCw } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { fmtRelative } from '@/lib/client/format';
import {
  Badge, Banner, Button, Card, CardHeader, ConfirmDialog, Dialog, EmptyState, ErrorNotice, ErrorState, Field, Input, Select, Skeleton, useToast,
} from '@/components/ui';

interface KeyView { id: string; prefix: string; label: string | null; created_at: string; expires_at: string | null; revoked_at: string | null; last_used_at: string | null; status: 'active' | 'revoked' | 'expired' }
interface SaView {
  id: string; name: string; description: string | null; purpose: string; status: 'active' | 'disabled' | 'expired';
  owner: { user_id: string; email: string; name: string | null }; expires_at: string | null; last_used_at: string | null; created_at: string;
  grants: Array<{ id: string; role: string; brand_id: string | null; brand_name: string | null }>; keys: KeyView[];
}
interface ListView { items: SaView[]; members: Array<{ user_id: string; email: string; name: string | null }>; brands: Array<{ id: string; name: string }>; roles: string[] }
interface Issued { id: string; prefix: string; secret: string; expires_at: string | null }

const ROLE_LABEL: Record<string, string> = { integration: 'Create drafts', viewer: 'Read', editor: 'Edit drafts' };
const statusTone = (s: string) => (s === 'active' ? 'success' : s === 'expired' ? 'warn' : 'neutral') as 'success' | 'warn' | 'neutral';

export function ServiceAccountsSettings() {
  const { canV2 } = useSession();
  const toast = useToast();
  const allowed = canV2('service_accounts.manage');
  const { data, error, loading, refetch } = useApi<ListView>(allowed ? '/api/service-accounts' : null);
  const [createOpen, setCreateOpen] = useState(false);
  const [issued, setIssued] = useState<{ name: string; key: Issued } | null>(null);
  const [confirm, setConfirm] = useState<null | { title: string; label: string; run: () => Promise<unknown> }>(null);

  if (!allowed) return <EmptyState icon={<Bot aria-hidden />} title="Owners and admins only" />;
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data) return <Skeleton className="h-64 w-full max-w-3xl rounded-xl" />;

  const newKey = async (sa: SaView) => {
    try {
      const r = await api.post<{ key: Issued }>(`/api/service-accounts/${sa.id}/keys`, {});
      setIssued({ name: sa.name, key: r.key });
      await refetch();
    } catch (e) { toast.error(e, 'Key not created'); }
  };
  const rotate = (sa: SaView, k: KeyView) => setConfirm({ title: `Rotate ${k.prefix}?`, label: 'Rotate', run: async () => {
    const r = await api.post<{ key: Issued }>(`/api/service-accounts/${sa.id}/keys/${k.id}/rotate`, {});
    setIssued({ name: sa.name, key: r.key });
    await refetch();
  } });
  const revoke = (sa: SaView, k: KeyView) => setConfirm({ title: `Revoke ${k.prefix}?`, label: 'Revoke', run: async () => {
    await api.del(`/api/service-accounts/${sa.id}/keys/${k.id}`); toast.success('Key revoked'); await refetch();
  } });
  const disable = (sa: SaView) => setConfirm({ title: `Disable ${sa.name}?`, label: 'Disable', run: async () => {
    await api.post(`/api/service-accounts/${sa.id}/disable`, {}); toast.success('Disabled'); await refetch();
  } });

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Card>
        <CardHeader title="Service accounts" actions={<Button variant="primary" size="sm" icon={<Plus aria-hidden className="size-4" />} onClick={() => setCreateOpen(true)} data-testid="sa-new">New</Button>} />
        {data.items.length === 0 ? (
          <div className="px-4 pb-4"><EmptyState icon={<Bot aria-hidden />} title="No service accounts" /></div>
        ) : (
          <ul className="divide-y divide-border" data-testid="sa-list">
            {data.items.map((sa) => (
              <li key={sa.id} className="flex flex-col gap-3 px-4 py-4" data-sa-name={sa.name}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">{sa.name}<Badge tone={statusTone(sa.status)}>{sa.status}</Badge>{sa.purpose === 'tipsignal' ? <Badge>TipSignal</Badge> : null}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {sa.grants.map((g) => `${ROLE_LABEL[g.role] ?? g.role} · ${g.brand_name ?? 'workspace'}`).join(', ') || 'No access'}
                      {' · '}owner {sa.owner.name ?? sa.owner.email}
                      {sa.expires_at ? ` · expires ${new Date(sa.expires_at).toLocaleDateString('en-GB')}` : ''}
                      {' · '}{sa.last_used_at ? `used ${fmtRelative(sa.last_used_at)}` : 'never used'}
                    </p>
                  </div>
                  {sa.status === 'active' && sa.purpose !== 'tipsignal' ? (
                    <div className="flex gap-2">
                      <Button size="sm" icon={<KeyRound aria-hidden className="size-4" />} onClick={() => void newKey(sa)}>New key</Button>
                      <Button size="sm" variant="quiet" onClick={() => disable(sa)}>Disable</Button>
                    </div>
                  ) : null}
                </div>
                {sa.keys.length ? (
                  <ul className="flex flex-col gap-1">
                    {sa.keys.map((k) => (
                      <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-raised px-3 py-1.5 text-[13px]" data-key-prefix={k.prefix}>
                        <span className="flex min-w-0 flex-wrap items-center gap-2">
                          <code className="font-mono text-[12px]">{k.prefix}_…</code>
                          <Badge tone={statusTone(k.status)}>{k.status}</Badge>
                          <span className="text-muted">{k.last_used_at ? `used ${fmtRelative(k.last_used_at)}` : 'never used'}{k.expires_at ? ` · expires ${new Date(k.expires_at).toLocaleDateString('en-GB')}` : ''}</span>
                        </span>
                        {k.status === 'active' && sa.status === 'active' ? (
                          <span className="flex gap-1">
                            <Button size="sm" variant="quiet" icon={<RotateCw aria-hidden className="size-3.5" />} onClick={() => rotate(sa, k)}>Rotate</Button>
                            <Button size="sm" variant="quiet" onClick={() => revoke(sa, k)}>Revoke</Button>
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {createOpen ? <CreateDialog data={data} onClose={() => setCreateOpen(false)} onCreated={async (name, key) => { setCreateOpen(false); setIssued({ name, key }); await refetch(); }} /> : null}
      {issued ? <KeyDialog name={issued.name} issued={issued.key} onClose={() => setIssued(null)} /> : null}
      {confirm ? <ConfirmDialog open onOpenChange={(o) => { if (!o) setConfirm(null); }} title={confirm.title} confirmLabel={confirm.label} confirmVariant="danger" onConfirm={confirm.run} /> : null}
    </div>
  );
}

function CreateDialog({ data, onClose, onCreated }: { data: ListView; onClose: () => void; onCreated: (name: string, key: Issued) => Promise<void> }) {
  const { session } = useSession();
  const [name, setName] = useState('');
  const [brandId, setBrandId] = useState(data.brands[0]?.id ?? '');
  const [role, setRole] = useState('integration');
  const [owner, setOwner] = useState(session.user.id);
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ service_account: SaView; key: Issued }>('/api/service-accounts', {
        name, brand_id: brandId, role, owner_user_id: owner, expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
      }, { idempotent: true });
      await onCreated(r.service_account.name, r.key);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title="New service account" busy={busy}
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={submit} loading={busy} disabledReason={!name.trim() ? 'Name it first' : !brandId ? 'Choose a brand' : null} data-testid="sa-create">Create</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-testid="sa-name" /></Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Brand"><Select value={brandId} onChange={(e) => setBrandId(e.target.value)} data-testid="sa-brand">{data.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          <Field label="Access" info="Service accounts never publish or manage the workspace."><Select value={role} onChange={(e) => setRole(e.target.value)}>{data.roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r] ?? r}</option>)}</Select></Field>
          <Field label="Owner"><Select value={owner} onChange={(e) => setOwner(e.target.value)}>{data.members.map((m) => <option key={m.user_id} value={m.user_id}>{m.name ? `${m.name} · ` : ''}{m.email}</option>)}</Select></Field>
          <Field label="Expires" info="Optional. At most one year."><Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
        </div>
        {err ? <ErrorNotice error={err} /> : null}
      </div>
    </Dialog>
  );
}

function KeyDialog({ name, issued, onClose }: { name: string; issued: Issued; onClose: () => void }) {
  const toast = useToast();
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={`Key for ${name}`}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="flex flex-col gap-3">
        <Banner tone="warn" title="Shown once">Copy it now. Only the prefix is kept visible.</Banner>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-raised p-2">
          <code className="min-w-0 flex-1 break-all font-mono text-[12px]" data-testid="sa-secret">{issued.secret}</code>
          <Button size="sm" icon={<Copy aria-hidden className="size-4" />} onClick={async () => { try { await navigator.clipboard.writeText(issued.secret); toast.success('Copied'); } catch { toast.error(new Error('Copy failed'), 'Copy failed'); } }}>Copy</Button>
        </div>
        <p className="text-xs text-muted">Use as <code className="font-mono">Authorization: Bearer …</code></p>
      </div>
    </Dialog>
  );
}
