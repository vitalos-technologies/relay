'use client';
// Platform → Workspaces → [id] → Billing (operator / billing staff). Billing record, provider references with "open in
// provider" links (refunds and disputes are handled there — no refund button here), trial with extension, payment issue,
// invoices, lifecycle history, webhook failures and scheduled lifecycle actions. Suspension ≠ cancellation: separate actions.
import { useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import type { PlatformBillingDetailDto } from '@social-lite/core/contracts/v4-billing-dto';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Badge, Banner, Button, Card, CardHeader, ErrorState, Facts, Field, Input, SkeletonRows, useToast } from '@/components/ui';
import type { ReactNode } from 'react';
import { Ago, ReasonDialog } from '@/components/admin/ui';
import { ACCESS_TONE, STATUS_LABEL, STATUS_TONE, day, money, seatsLabel } from './format';

const Ext = ({ href, children }: { href: string | null; children: ReactNode }) => href
  ? <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 break-all font-mono text-[12px] text-accent-text hover:underline">{children}<ExternalLink aria-hidden className="size-3.5 shrink-0" /></a>
  : <span className="break-all font-mono text-[12px]">{children}</span>;

export function PlatformBillingPanel({ workspaceId, operator }: { workspaceId: string; operator: boolean }) {
  const toast = useToast();
  const { data: d, error, refetch } = useApi<PlatformBillingDetailDto>(`/api/platform/billing/workspaces/${workspaceId}`);
  const [dialog, setDialog] = useState<null | 'extend' | 'cancel' | 'resume' | 'suspend'>(null);
  const [days, setDays] = useState('7');
  const [runAt, setRunAt] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [cancelAction, setCancelAction] = useState<string | null>(null);
  if (error && !d) return <Card><ErrorState error={error} onRetry={refetch} /></Card>;
  if (!d) return <Card><SkeletonRows rows={4} /></Card>;
  const s = d.state;
  const live = !!d.provider.subscription_ref && !!d.provider.provider_status && !['canceled', 'incomplete_expired'].includes(d.provider.provider_status);
  const reconcile = async () => {
    setSyncing(true);
    try { await api.post(`/api/platform/billing/workspaces/${workspaceId}/reconcile`, {}); toast.success('Re-fetched from the provider'); await refetch(); } catch (e) { toast.error((e as Error).message); } finally { setSyncing(false); }
  };
  return (
    <Card data-testid="platform-billing">
      <CardHeader title="Billing" actions={<div className="flex flex-wrap gap-2">
        <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>
        <Badge tone={ACCESS_TONE[s.access]}>Access: {s.access}</Badge>
        {d.provider.name ? <Button size="sm" variant="ghost" icon={<RefreshCw aria-hidden className="size-4" />} loading={syncing} onClick={() => void reconcile()}>Re-fetch</Button> : null}
      </div>} />
      <div className="flex flex-col gap-4 px-4 pb-4">
        {d.duplicate_subscriptions.length ? <Banner tone="danger" title="Duplicate subscription at the provider">Cancel {d.duplicate_subscriptions.join(', ')} in the provider; Relay kept {d.provider.subscription_ref}.</Banner> : null}
        {d.payment_issue ? <Banner tone="warn" title={d.payment_issue.action_required ? 'Customer must confirm a payment' : 'Payment failed'}>Since {day(d.payment_issue.since)} · grace ends {day(d.payment_issue.grace_ends_at)}</Banner> : null}
        {s.service_suspended ? <Banner tone="danger" title="Service suspended by Relay">Billing is unchanged by suspension.</Banner> : null}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Facts items={[
            ['Plan', `${d.plan_name ?? 'None'}${d.plan_version ? ` · v${d.plan_version}` : ''}`],
            ['Seats', s.plan_id === 'free' ? `Free · ${d.seats.billable} ${d.seats.billable === 1 ? 'user' : 'users'} (1 included)` : `${seatsLabel(d.seats.paid)} · ${d.seats.billable} billable`],
            ['Trial', d.trial ? `${day(d.trial.started_at)} → ${day(d.trial.ends_at)}${d.trial.extensions ? ` (+${d.trial.extensions} ext.)` : ''}` : '—'],
            ['Period', s.current_period ? `${day(s.current_period.start)} → ${day(s.current_period.end)}` : '—'],
            ['Cancels', s.cancel_at ? day(s.cancel_at) : '—'],
            ['Scheduled', s.scheduled_change ? `${s.scheduled_change.plan_id ?? ''} ${s.scheduled_change.seats ? seatsLabel(s.scheduled_change.seats) : ''} from ${day(s.scheduled_change.effective_at)}` : '—'],
            ...(s.access_reason ? [['Reason', s.access_reason] as [string, ReactNode]] : []),
          ]} />
          <Facts items={[
            ['Provider', d.provider.name ? `${d.provider.name === 'test' ? 'Test double' : 'Stripe'}${d.provider.livemode ? ' · live' : ' · test mode'}` : 'None'],
            ['Customer', d.provider.customer_ref ? <Ext key="c" href={d.provider.customer_url}>{d.provider.customer_ref}</Ext> : '—'],
            ['Subscription', d.provider.subscription_ref ? <Ext key="s" href={d.provider.subscription_url}>{d.provider.subscription_ref}</Ext> : '—'],
            ['Provider status', d.provider.provider_status ?? '—'],
            ['Last synced', <Ago key="a" at={d.provider.synced_at} />],
            ['Trial redeemed by', d.trial?.redeemed_by ?? '—'],
          ]} />
        </div>
        {d.can_act ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {d.trial?.eligible_for_extension ? <Button size="sm" className="w-full sm:w-auto" onClick={() => setDialog('extend')}>Extend trial</Button> : null}
            {live && !d.state.cancel_at ? <Button size="sm" className="w-full sm:w-auto" onClick={() => setDialog('cancel')}>Cancel renewal</Button> : null}
            {live && d.state.cancel_at ? <Button size="sm" className="w-full sm:w-auto" onClick={() => setDialog('resume')}>Resume renewal</Button> : null}
            {operator && !s.service_suspended ? <Button size="sm" variant="ghost" className="w-full sm:w-auto" onClick={() => setDialog('suspend')}>Schedule suspension</Button> : null}
            {d.provider.customer_url ? <a href={d.provider.customer_url} target="_blank" rel="noreferrer noopener" className="inline-flex h-9 items-center justify-center gap-1 rounded-lg px-3 text-[13px] font-medium text-accent-text hover:bg-raised">Refunds in provider<ExternalLink aria-hidden className="size-3.5" /></a> : null}
          </div>
        ) : null}
        {d.scheduled_actions.filter((a) => a.status === 'scheduled').map((a) => (
          <Banner key={a.id} tone="warn" title={`Suspension scheduled for ${new Date(a.run_at).toLocaleString()}`}
            actions={operator ? <Button size="sm" onClick={() => setCancelAction(a.id)}>Cancel</Button> : null}>
            {a.reason} · {a.created_by}</Banner>
        ))}
        <details>
          <summary className="cursor-pointer text-[13px] font-medium">Invoices ({d.invoices.length})</summary>
          <ul className="mt-2 divide-y divide-border text-[13px]">
            {!d.invoices.length ? <li className="py-2 text-muted">None</li> : d.invoices.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-x-3 py-2"><span className="min-w-0 flex-1 truncate">{i.number ?? i.id}</span><span className="tabular">{money(i.total_minor)}</span><Badge tone={i.status === 'paid' ? 'success' : 'warn'}>{i.status}</Badge>{i.provider_url ? <Ext href={i.provider_url}>open</Ext> : null}</li>
            ))}
          </ul>
        </details>
        <details open>
          <summary className="cursor-pointer text-[13px] font-medium">Lifecycle history</summary>
          <ul className="mt-2 divide-y divide-border text-[13px]" data-testid="platform-billing-lifecycle">
            {d.lifecycle.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 py-2"><code className="text-[12px]">{e.kind}</code>
                <span className="text-muted">{e.from_status === e.to_status ? e.to_status : `${e.from_status ?? '—'} → ${e.to_status}`}</span>
                <span className="min-w-0 flex-1 truncate text-muted">{e.actor ?? e.source}{e.reason ? ` · ${e.reason}` : ''}</span><Ago at={e.at} className="text-xs text-muted" /></li>
            ))}
          </ul>
        </details>
        {d.webhook_failures.length ? (
          <details>
            <summary className="cursor-pointer text-[13px] font-medium text-danger">Failed provider events ({d.webhook_failures.length})</summary>
            <ul className="mt-2 text-[13px]">{d.webhook_failures.map((f) => <li key={f.id} className="py-1"><code>{f.type}</code> · {f.attempts} attempts · {f.last_error}</li>)}</ul>
          </details>
        ) : null}
      </div>
      <ReasonDialog open={dialog === 'extend'} onOpenChange={(o) => !o && setDialog(null)} confirmLabel="Extend trial" title="Extend the free trial"
        description={`At most 3 extensions of up to 30 days. Needs a fresh sign-in. Current end: ${day(d.trial?.ends_at)}.`}
        onConfirm={async (reason) => { await api.post(`/api/platform/billing/workspaces/${workspaceId}/trial`, { days: Number(days), reason }); toast.success('Trial extended'); await refetch(); }}>
        <Field label="Days"><Input type="number" min={1} max={30} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
      </ReasonDialog>
      <ReasonDialog open={dialog === 'cancel' || dialog === 'resume'} onOpenChange={(o) => !o && setDialog(null)} confirmVariant={dialog === 'cancel' ? 'danger' : 'primary'}
        confirmLabel={dialog === 'cancel' ? 'Cancel renewal' : 'Resume renewal'} title={dialog === 'cancel' ? 'Cancel renewal at period end?' : 'Resume renewal?'}
        description={dialog === 'cancel' ? 'Billing only: the service continues until the period ends and is not suspended. The customer sees this in Billing.' : 'The subscription renews again.'}
        onConfirm={async (reason) => { await api.post(`/api/platform/billing/workspaces/${workspaceId}/renewal`, { cancel: dialog === 'cancel', reason }); toast.success('Saved'); await refetch(); }} />
      <ReasonDialog open={dialog === 'suspend'} onOpenChange={(o) => !o && setDialog(null)} confirmVariant="danger" confirmLabel="Schedule suspension" title="Schedule a service suspension"
        description="Members lose access at that time; nothing publishes. Billing is NOT cancelled by this. Operator only, needs a fresh sign-in."
        onConfirm={async (reason) => { await api.post(`/api/platform/billing/workspaces/${workspaceId}/lifecycle`, { action: 'suspend', run_at: new Date(runAt).toISOString(), reason }); toast.success('Scheduled'); await refetch(); }}>
        <Field label="When"><Input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} /></Field>
      </ReasonDialog>
      <ReasonDialog open={!!cancelAction} onOpenChange={(o) => !o && setCancelAction(null)} confirmLabel="Cancel scheduled suspension" title="Cancel the scheduled suspension?"
        onConfirm={async (reason) => { await api.post(`/api/platform/billing/workspaces/${workspaceId}/lifecycle/${cancelAction}`, { reason }); toast.success('Cancelled'); setCancelAction(null); await refetch(); }} />
    </Card>
  );
}
