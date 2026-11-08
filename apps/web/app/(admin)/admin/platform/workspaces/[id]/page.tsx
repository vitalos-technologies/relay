'use client';
// Platform → Workspace detail: lifecycle (suspend/reactivate), dispatch share, support access request, platform audit.
// Metadata and aggregates only. Private content needs approved support access (requested here, approved by the workspace).
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ArrowLeft, LifeBuoy } from 'lucide-react';
import { PROVIDER_LABEL } from '@social-lite/core';
import type { PlatformWorkspaceDetail } from '@social-lite/core/contracts/v31-admin';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Badge, Banner, Button, Card, CardHeader, ErrorState, Facts, Field, Input, PageHeader, Select, SkeletonRows, useToast } from '@/components/ui';
import { Ago, ReasonDialog } from '@/components/admin/ui';
import { SUPPORT_TONE, WsState } from '@/components/admin/badges';
import { PlatformBillingPanel } from '@/components/billing/platform-billing-panel';
import { PlatformEntitlements } from '@/components/entitlements/platform-entitlements';

export default function PlatformWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const { session } = useSession();
  const toast = useToast();
  const { data: w, error, refetch } = useApi<PlatformWorkspaceDetail>(`/api/platform/workspaces/${id}`);
  const [dialog, setDialog] = useState<null | 'suspend' | 'reactivate' | 'concurrency' | 'support'>(null);
  const [cc, setCc] = useState('');
  const [minutes, setMinutes] = useState('60');
  const [ticket, setTicket] = useState('');
  const operator = session.platform_role === 'operator';
  const billingStaff = operator || session.platform_role === 'billing'; // V4: billing panel (BIL); support access is not for billing staff
  const mine = w?.support_access.find((s) => s.operator.id === session.user.id && (s.status === 'requested' || s.status === 'active'));
  if (error && !w) return <ErrorState error={error} onRetry={refetch} />;
  if (!w) return <SkeletonRows rows={8} />;
  return (
    <>
      <PageHeader title={w.name} eyebrow={<Link href="/admin/platform/workspaces" className="inline-flex items-center gap-1 hover:text-fg"><ArrowLeft aria-hidden className="size-3.5" />Workspaces</Link>}
        meta={<WsState w={w} />}
        actions={<>
          {!mine && session.platform_role !== 'billing' ? <Button size="sm" icon={<LifeBuoy aria-hidden className="size-4" />} onClick={() => setDialog('support')}>Request support access</Button> : null}
          {operator ? (w.state === 'suspended'
            ? <Button size="sm" variant="primary" onClick={() => setDialog('reactivate')}>Reactivate</Button>
            : <Button size="sm" variant="danger" onClick={() => setDialog('suspend')}>Suspend</Button>) : null}
        </>} />
      <div className="flex flex-col gap-6">
        {w.state === 'suspended' ? <Banner tone="danger" title="Suspended — members can’t sign in to it and nothing publishes">{w.suspended_reason}</Banner> : null}
        {mine ? <Banner tone="info" title={mine.status === 'active' ? 'Your support access is active' : 'Your request is waiting for the workspace'}
          actions={<Button size="sm" onClick={async () => { await api.post(`/api/platform/support-access/${mine.id}/end`, {}); toast.success('Ended'); await refetch(); }}>{mine.status === 'active' ? 'End' : 'Cancel'}</Button>}>
          {mine.status === 'active' ? <>Read-only until <Ago at={mine.expires_at} />. Switch to this workspace to view it.</> : mine.reason}</Banner> : null}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Workspace" />
            <Facts className="px-4 pb-4" items={[
              ['Created', new Date(w.created_at).toLocaleDateString()],
              ['Owners', w.owners.map((o) => o.email).join(', ') || '—'],
              ['Members', Object.entries(w.member_status).map(([k, v]) => `${v} ${k}`).join(' · ') || '0'],
              ['Brands', w.brands],
              ['Last activity', <Ago key="a" at={w.last_activity_at} />],
              ['Publishing', w.publishing_paused ? `Paused${w.paused_reason ? ` · ${w.paused_reason}` : ''}` : 'On'],
              ['Dispatch share', <span key="d" className="inline-flex items-center gap-2">{w.dispatch_concurrency ?? 'Default'}{operator ? <Button size="sm" variant="ghost" onClick={() => { setCc(String(w.dispatch_concurrency ?? '')); setDialog('concurrency'); }}>Change</Button> : null}</span>],
              ['Flag overrides', w.flag_overrides.map((f) => `${f.key} ${f.enabled ? 'on' : 'off'}`).join(', ') || 'None'],
            ]} />
          </Card>
          <Card>
            <CardHeader title="Publishing · 7 days (live)" />
            <div className="flex flex-wrap gap-2 px-4 pb-4">
              {Object.keys(w.deliveries_7d).length ? Object.entries(w.deliveries_7d).map(([k, v]) => <Badge key={k} tone={k === 'published' ? 'success' : ['failed', 'unknown', 'expired'].includes(k) ? 'warn' : 'neutral'}>{k} {v}</Badge>) : <span className="text-[13px] text-muted">No live results</span>}
            </div>
            <CardHeader title="Accounts" />
            <ul className="px-4 pb-4 text-[13px]">
              {w.connections_by_provider.length ? w.connections_by_provider.map((c) => <li key={`${c.provider}-${c.status}`} className="flex gap-2 py-1"><span className="flex-1">{PROVIDER_LABEL[c.provider]}</span><span className="text-muted">{c.status}</span><span className="tabular">{c.n}{c.simulated ? ` (${c.simulated} sim)` : ''}</span></li>) : <li className="text-muted">None</li>}
            </ul>
          </Card>
        </div>
        {billingStaff ? <PlatformBillingPanel workspaceId={w.id} operator={operator} /> : null}
        <PlatformEntitlements workspaceId={w.id} />
        <Card>
          <CardHeader title="Support access" />
          <ul className="divide-y divide-border px-4 pb-2 text-[13px]">
            {!w.support_access.length ? <li className="py-3 text-muted">None</li> : w.support_access.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 py-2"><Badge tone={SUPPORT_TONE[s.status]}>{s.status}</Badge><span>{s.operator.email}</span><span className="min-w-0 flex-1 truncate text-muted">{s.reason}</span><Ago at={s.requested_at} className="text-xs text-muted" /></li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Platform audit" actions={<Link href={`/admin/platform/audit?workspace_id=${w.id}`} className="text-[13px] font-medium text-accent-text hover:underline">All</Link>} />
          <ul className="divide-y divide-border px-4 pb-2 text-[13px]">
            {!w.audit.length ? <li className="py-3 text-muted">None</li> : w.audit.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 py-2"><code className="text-[12px]">{a.action}</code><span className="text-muted">{a.actor}</span><span className="min-w-0 flex-1 truncate text-muted">{a.reason}</span><Ago at={a.at} className="text-xs text-muted" /></li>
            ))}
          </ul>
        </Card>
      </div>
      <ReasonDialog open={dialog === 'suspend'} onOpenChange={(o) => !o && setDialog(null)} confirmVariant="danger" confirmLabel="Suspend workspace"
        title={`Suspend ${w.name}?`} description={`Members lose access on their next request and ${w.scheduled} scheduled post(s) hold at send time. Memberships and content are kept. Needs a fresh sign-in.`}
        onConfirm={async (reason) => { await api.post(`/api/platform/workspaces/${w.id}/suspend`, { reason }); toast.success('Suspended'); await refetch(); }} />
      <ReasonDialog open={dialog === 'reactivate'} onOpenChange={(o) => !o && setDialog(null)} confirmLabel="Reactivate"
        title={`Reactivate ${w.name}?`} description="Members regain access. Held posts still on time are queued again."
        onConfirm={async (reason) => { await api.post(`/api/platform/workspaces/${w.id}/reactivate`, { reason }); toast.success('Reactivated'); await refetch(); }} />
      <ReasonDialog open={dialog === 'concurrency'} onOpenChange={(o) => !o && setDialog(null)} confirmLabel="Save"
        title="Dispatch share" description="Maximum publications this workspace sends at once across all workers. Empty = installation default."
        onConfirm={async (reason) => { await api.post(`/api/platform/workspaces/${w.id}/dispatch-concurrency`, { dispatch_concurrency: cc ? Number(cc) : null, reason }); toast.success('Saved'); await refetch(); }}>
        <Field label="Concurrent sends"><Input type="number" min={1} max={32} inputMode="numeric" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="Default" /></Field>
      </ReasonDialog>
      <ReasonDialog open={dialog === 'support'} onOpenChange={(o) => !o && setDialog(null)} confirmLabel="Send request"
        title="Request read-only support access" description="A workspace owner or admin must approve. Access ends automatically; everything you open is attributed to you."
        onConfirm={async (reason) => { await api.post('/api/platform/support-access', { workspace_id: w.id, reason, ticket_ref: ticket.trim() || null, duration_minutes: Number(minutes) }); toast.success('Request sent'); setTicket(''); await refetch(); }}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Duration"><Select value={minutes} onChange={(e) => setMinutes(e.target.value)}><option value="30">30 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option><option value="1440">24 hours</option></Select></Field>
          <Field label="Ticket" optional><Input value={ticket} onChange={(e) => setTicket(e.target.value)} maxLength={80} /></Field>
        </div>
      </ReasonDialog>
    </>
  );
}
