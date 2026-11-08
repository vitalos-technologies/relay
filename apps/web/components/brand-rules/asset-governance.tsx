'use client';
// V3.1 §12 asset governance in the library drawer: ownership/licence notes, expiry, superseded/archived.
// GET/PATCH /api/assets/:id/governance (assets.manage to change). Expired assets are refused at schedule time
// by the server; superseded ones are flagged there too.
import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { AssetGovernanceDto, AssetLifecycle, AssetOwnership, RuleChangeImpact } from '@social-lite/core/contracts/v31-gov';
import { toLocalInput } from '@social-lite/core';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { fmtDate } from '@/lib/client/format';
import { wallToIso } from '@/components/collab/conflict-copy';
import { Badge, Button, ErrorNotice, Field, Input, Select, Skeleton, Textarea, useToast } from '@/components/ui';
import { impactText } from './brand-rules-settings';

const OWNERSHIP: Record<AssetOwnership, string> = { owned: 'Owned', licensed: 'Licensed', stock: 'Stock', partner: 'Partner', user_generated: 'User-generated', unknown: 'Unknown' };

export function AssetGovernancePanel({ assetId, brandId }: { assetId: string; brandId: string }) {
  const { session, canOn } = useSession();
  const toast = useToast();
  const tz = session.workspace?.timezone ?? 'UTC';
  const { data, error, setData } = useApi<AssetGovernanceDto>(`/api/assets/${assetId}/governance`);
  const [f, setF] = useState<{ ownership: AssetOwnership; owner: string; licence: string; url: string; notes: string; expires: string; lifecycle: AssetLifecycle } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (data) setF({ ownership: data.ownership, owner: data.owner_name ?? '', licence: data.licence ?? '', url: data.licence_url ?? '', notes: data.notes ?? '', expires: data.expires_at ? toLocalInput(new Date(data.expires_at), tz).slice(0, 10) : '', lifecycle: data.lifecycle });
  }, [data, tz]);
  if (error && !data) return <ErrorNotice error={error} />;
  if (!data || !f) return <Skeleton className="h-24 w-full rounded-lg" />;
  const ro = !canOn(brandId, 'assets.manage');
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.patch<AssetGovernanceDto & { impact?: RuleChangeImpact }>(`/api/assets/${assetId}/governance`, {
        ownership: f.ownership, owner_name: f.owner.trim() || null, licence: f.licence.trim() || null, licence_url: f.url.trim() || null,
        notes: f.notes.trim() || null, expires_at: f.expires ? wallToIso(`${f.expires}T23:59`, tz) : null, lifecycle: f.lifecycle,
      });
      setData(r);
      toast.success('Licence saved', r.impact ? impactText(r.impact) : undefined);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const state = data.expiry_state;
  return (
    <section aria-labelledby={`gov-${assetId}`} className="flex flex-col gap-3 border-t border-border pt-4" data-testid="asset-governance">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`gov-${assetId}`} className="flex items-center gap-1.5 text-[13px] font-semibold"><ShieldCheck aria-hidden className="size-4" />Licence and expiry</h3>
        {state === 'expired' ? <Badge tone="danger">Expired</Badge> : state === 'expiring' ? <Badge tone="warn">Expires {data.expires_at ? fmtDate(data.expires_at, tz) : 'soon'}</Badge> : null}
        {data.lifecycle !== 'active' ? <Badge tone="warn">{data.lifecycle === 'superseded' ? 'Superseded' : 'Archived'}</Badge> : null}
        {data.is_approved_logo ? <Badge tone="success">Approved logo</Badge> : null}
      </div>
      {data.usage.live_schedules || data.usage.drafts ? <p className="text-xs text-muted">Used by {data.usage.live_schedules} scheduled · {data.usage.drafts} drafts</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Ownership">
          <Select value={f.ownership} disabled={ro} onChange={(e) => setF({ ...f, ownership: e.target.value as AssetOwnership })}>
            {Object.entries(OWNERSHIP).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Owner" optional><Input value={f.owner} readOnly={ro} onChange={(e) => setF({ ...f, owner: e.target.value })} maxLength={200} /></Field>
        <Field label="Licence" optional><Input value={f.licence} readOnly={ro} onChange={(e) => setF({ ...f, licence: e.target.value })} maxLength={200} /></Field>
        <Field label="Expires" optional><Input type="date" value={f.expires} readOnly={ro} onChange={(e) => setF({ ...f, expires: e.target.value })} /></Field>
        <Field label="Licence link" optional className="sm:col-span-2"><Input value={f.url} readOnly={ro} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://" maxLength={2048} /></Field>
        <Field label="Status">
          <Select value={f.lifecycle} disabled={ro} onChange={(e) => setF({ ...f, lifecycle: e.target.value as AssetLifecycle })}>
            <option value="active">Active</option>
            <option value="superseded">Superseded</option>
            <option value="archived">Archived</option>
          </Select>
        </Field>
        <Field label="Notes" optional className="sm:col-span-2"><Textarea value={f.notes} readOnly={ro} rows={2} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={2000} /></Field>
      </div>
      {err ? <ErrorNotice error={err} /> : null}
      {!ro ? <div><Button size="sm" variant="secondary" loading={busy} onClick={() => void save()}>Save licence</Button></div> : null}
    </section>
  );
}
