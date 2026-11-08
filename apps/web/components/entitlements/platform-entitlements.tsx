'use client';
// Platform → Workspaces → <workspace>: plan, access, usage summary, held work and audited entitlement overrides.
// Support staff read; operator/billing staff apply/revoke (reason + optional expiry, fresh sign-in). Metadata only.
import { useState } from 'react';
import { FEATURES, ALLOWANCES, type Allowance, type Feature } from '@social-lite/core/contracts/v4-plans';
import { ALLOWANCE_LABEL, FEATURE_LABEL, type EntitlementsDto } from '@social-lite/core/contracts/v4-entitlements';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Badge, Button, Card, CardHeader, ErrorState, Facts, Field, Input, Select, SkeletonRows, useToast } from '@/components/ui';
import { Ago, ReasonDialog } from '@/components/admin/ui';
import { AllowanceRow } from './workspace-usage';

type View = EntitlementsDto & { can_override: boolean };
type Kind = 'feature' | 'allowance' | 'access';

export function PlatformEntitlements({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const { data, error, refetch, setData } = useApi<View>(`/api/platform/entitlements/${workspaceId}`);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('feature');
  const [feature, setFeature] = useState<Feature>('listening');
  const [enabled, setEnabled] = useState('on');
  const [allowance, setAllowance] = useState<Allowance>('ai_tokens');
  const [limit, setLimit] = useState('');
  const [days, setDays] = useState('30');
  const [revoke, setRevoke] = useState<string | null>(null);
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (!data) return <SkeletonRows rows={4} />;
  const held = data.held.scheduled_posts + data.held.queued_replies + data.held.sync_jobs;
  const metered = data.allowances.filter((a) => a.hard_limit !== null || a.used > 0);
  const live = data.overrides.filter((o) => o.status === 'active');
  const expiresAt = days ? new Date(Date.now() + Number(days) * 86_400_000).toISOString() : null;
  const label = (k: string, kd: string) => (kd === 'feature' ? FEATURE_LABEL[k as Feature] ?? k : kd === 'access' ? 'Temporary full access' : ALLOWANCE_LABEL[k as Allowance]?.label ?? k);
  return (
    <Card data-testid="platform-entitlements">
      <CardHeader title="Entitlements" actions={data.can_override ? <Button size="sm" onClick={() => setOpen(true)}>Apply override</Button> : null} />
      <Facts className="px-4 pb-3" items={[
        ['Plan', data.plan?.name ?? 'No plan'],
        ['Status', <span key="s" className="capitalize">{data.status.replace(/_/g, ' ')}</span>],
        ['Access', <Badge key="a" tone={data.access === 'full' ? 'success' : data.access === 'restricted' ? 'warn' : 'danger'}>{data.access}</Badge>],
        ...(data.access_reason ? [['Reason', data.access_reason] as [string, string]] : []),
        ['Held work', held ? `${data.held.scheduled_posts} posts · ${data.held.queued_replies} replies · ${data.held.sync_jobs} jobs` : 'None'],
      ]} />
      {metered.length ? <ul className="divide-y divide-border border-t border-border">{metered.map((a) => <AllowanceRow key={a.key} a={a} />)}</ul> : null}
      <CardHeader title="Overrides" />
      <ul className="divide-y divide-border px-4 pb-2 text-[13px]">
        {!data.overrides.length ? <li className="py-3 text-muted">None</li> : data.overrides.map((o) => (
          <li key={o.id} className="flex flex-wrap items-center gap-2 py-2">
            <Badge tone={o.status === 'active' ? 'info' : 'neutral'}>{o.status}</Badge>
            <span className="font-medium">{label(o.key, o.kind)}</span>
            <span className="text-muted">{o.kind === 'feature' ? (o.value.enabled ? 'on' : 'off') : o.kind === 'allowance' ? (o.value.limit == null ? 'unmetered' : o.value.limit.toLocaleString('en-GB')) : ''}</span>
            <span className="min-w-0 flex-1 truncate text-muted">{o.reason}</span>
            <span className="text-xs text-muted">{o.expires_at ? <>ends <Ago at={o.expires_at} /></> : 'no end'}</span>
            {data.can_override && o.status === 'active' ? <Button size="sm" variant="ghost" onClick={() => setRevoke(o.id)}>Revoke</Button> : null}
          </li>
        ))}
      </ul>
      <ReasonDialog open={open} onOpenChange={setOpen} confirmLabel="Apply"
        title="Apply an entitlement override" description="Audited for Relay and the workspace. Needs a fresh sign-in. Full access never lifts a suspension."
        onConfirm={async (reason) => {
          const body = kind === 'feature' ? { kind, key: feature, enabled: enabled === 'on', reason, expires_at: expiresAt }
            : kind === 'allowance' ? { kind, key: allowance, limit: limit.trim() === '' ? null : Number(limit), reason, expires_at: expiresAt }
            : { kind, key: 'full', reason, expires_at: expiresAt ?? new Date(Date.now() + 7 * 86_400_000).toISOString() };
          const r = await api.post<{ entitlements: View }>(`/api/platform/entitlements/${workspaceId}`, body);
          setData(r.entitlements); toast.success('Override applied');
        }}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Scope"><Select value={kind} onChange={(e) => setKind(e.target.value as Kind)}><option value="feature">Feature</option><option value="allowance">Allowance</option><option value="access">Temporary full access</option></Select></Field>
          {kind === 'feature' ? <>
            <Field label="Feature"><Select value={feature} onChange={(e) => setFeature(e.target.value as Feature)}>{FEATURES.filter((f) => f !== 'support').map((f) => <option key={f} value={f}>{FEATURE_LABEL[f]}</option>)}</Select></Field>
            <Field label="Set to"><Select value={enabled} onChange={(e) => setEnabled(e.target.value)}><option value="on">On</option><option value="off">Off</option></Select></Field>
          </> : null}
          {kind === 'allowance' ? <>
            <Field label="Allowance"><Select value={allowance} onChange={(e) => setAllowance(e.target.value as Allowance)}>{ALLOWANCES.map((a) => <option key={a} value={a}>{ALLOWANCE_LABEL[a].label}</option>)}</Select></Field>
            <Field label="Limit" hint={ALLOWANCE_LABEL[allowance].unit === 'bytes' ? 'Bytes. Empty = unmetered' : 'Empty = unmetered'}><Input type="number" min={0} inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} /></Field>
          </> : null}
          <Field label="Ends"><Select value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="7">In 7 days</option><option value="30">In 30 days</option>{kind !== 'access' ? <><option value="90">In 90 days</option><option value="">No end date</option></> : null}
          </Select></Field>
        </div>
        {live.some((o) => o.kind === kind && o.key === (kind === 'feature' ? feature : kind === 'allowance' ? allowance : 'full')) ? <p className="text-xs text-muted">This replaces the current override for the same scope.</p> : null}
      </ReasonDialog>
      <ReasonDialog open={!!revoke} onOpenChange={(o) => !o && setRevoke(null)} confirmLabel="Revoke" confirmVariant="danger" title="Revoke this override?"
        description="The plan’s own entitlement applies again immediately."
        onConfirm={async (reason) => { setData(await api.post<View>(`/api/platform/entitlements/${workspaceId}/overrides/${revoke}/revoke`, { reason })); toast.success('Override revoked'); }} />
    </Card>
  );
}
