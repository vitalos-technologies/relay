'use client';
// Settings → Workspace → Plan and billing (billing.read to view, billing.manage to act). Reads stored, provider-verified
// state; a background refresh asks the provider after load (never during render). Hosted checkout / portal only.
// Returning from checkout proves nothing: the page waits for verified state and says so.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CreditCard, ExternalLink, FileText, Gauge, Minus, Plus, Receipt, RefreshCw, Users } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { EntitlementsDto } from '@social-lite/core/contracts/v4-entitlements';
import type { BillingChangePreviewDto, BillingOverviewDto } from '@social-lite/core/contracts/v4-billing-dto';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Badge, Banner, Button, Card, CardHeader, ConfirmDialog, Dialog, EmptyState, ErrorNotice, ErrorState, Facts, MetaChip, Skeleton, Spinner, cn, useToast } from '@/components/ui';
import { STATUS_LABEL, STATUS_TONE, day, money, seatsLabel, usersLabel } from './format';

type PlanId = 'standard' | 'professional';

function useQueryFlag(name: string): string | null {
  return useSearchParams().get(name);
}

export function BillingSettings() {
  const toast = useToast();
  const { data, error, loading, refetch, setData } = useApi<BillingOverviewDto>('/api/billing');
  const returned = useQueryFlag('checkout');
  const welcome = useQueryFlag('welcome');
  const [confirming, setConfirming] = useState(returned === 'returned');
  const [syncing, setSyncing] = useState(false);
  const refreshed = useRef(false);

  const refresh = useCallback(async (quiet = true) => {
    setSyncing(true);
    try {
      await api.post('/api/billing/refresh', {});
      setData(await api.get<BillingOverviewDto>('/api/billing'));
      if (!quiet) toast.success('Up to date');
    } catch (e) {
      if (!quiet) toast.error((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }, [setData, toast]);

  // Background provider refresh after first paint, only when there is something at the provider to look at.
  useEffect(() => {
    if (!data || refreshed.current) return;
    refreshed.current = true;
    const stale = !data.last_synced_at || Date.now() - new Date(data.last_synced_at).getTime() > 60_000;
    if (!(data.provider.configured && (data.open_checkout || (data.state.status !== 'legacy' && data.state.status !== 'none' && stale)))) return;
    const t = setTimeout(() => void refresh(true), 0);
    return () => clearTimeout(t);
  }, [data, refresh]);

  // Back from hosted checkout: poll for verified state (webhook or reconciliation) for up to ~30 s.
  useEffect(() => {
    if (returned !== 'returned') return;
    let n = 0;
    const t = setInterval(async () => {
      n++;
      try {
        await api.post('/api/billing/refresh', {});
        const d = await api.get<BillingOverviewDto>('/api/billing');
        setData(d);
        const activated = !!d.payment_method && ['active', 'trialing', 'cancel_scheduled'].includes(d.state.status) && !d.open_checkout && d.next_charge_at;
        if (activated || n >= 10) { clearInterval(t); setConfirming(false); }
      } catch { if (n >= 10) { clearInterval(t); setConfirming(false); } }
    }, 3000);
    return () => clearInterval(t);
  }, [returned, setData]);

  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data) return <div className="flex max-w-3xl flex-col gap-4"><Skeleton className="h-48 w-full rounded-xl" /><Skeleton className="h-64 w-full rounded-xl" /></div>;

  const d = data;
  const hasSub = d.actions.change_subscription || d.actions.reactivate || d.actions.cancel;
  const showPlans = d.can_manage && !hasSub && (d.actions.start_trial || d.actions.checkout || d.actions.change_trial_plan);
  return (
    <div className="flex max-w-3xl flex-col gap-6" data-testid="billing-settings">
      <div className="flex flex-wrap items-center gap-2">
        {d.provider.test_mode && d.provider.name ? <MetaChip className="bg-warn-soft text-fg">Test mode · no real payments</MetaChip> : null}
        {!d.provider.configured ? <MetaChip>Payments not set up</MetaChip> : null}
        <span className="ml-auto" />
        {d.provider.configured && d.state.status !== 'legacy' ? (
          <Button size="sm" variant="ghost" icon={<RefreshCw aria-hidden className={cn('size-4', syncing && 'animate-spin')} />} onClick={() => void refresh(false)} loading={false} disabled={syncing}>Refresh</Button>
        ) : null}
      </div>
      {welcome ? <Banner tone="success" title="Your 14-day free trial has started">No card needed. Choose a plan any time before {day(d.trial?.ends_at)}.</Banner> : null}
      {confirming ? (
        <Banner tone="info" icon={<Spinner label="Confirming" />} title="Confirming with the payment provider…">Your plan updates once payment is confirmed.</Banner>
      ) : returned === 'returned' && !d.payment_method ? (
        <Banner tone="warn" title="Not confirmed yet">The payment provider hasn’t confirmed yet. If you completed checkout, this page updates within a few minutes.</Banner>
      ) : null}
      {returned === 'cancelled' ? <Banner tone="neutral" title="Checkout cancelled">Nothing was charged.</Banner> : null}
      <AccessBanner d={d} onPortal={() => void openPortal('payment_method_update')} />
      <PlanCard d={d} onChanged={refetch} />
      {showPlans ? <ChoosePlan d={d} onChanged={refetch} /> : null}
      <SeatsCard d={d} />
      <UsageCard />
      <InvoicesCard d={d} />
    </div>
  );

  async function openPortal(flow: 'payment_method_update' | 'subscription_cancel' | null) {
    try {
      const r = await api.post<{ url: string }>('/api/billing/portal', { flow });
      window.location.assign(r.url);
    } catch (e) { toast.error((e as Error).message); }
  }
}

function AccessBanner({ d, onPortal }: { d: BillingOverviewDto; onPortal: () => void }) {
  if (d.state.access === 'full') {
    if (d.state.status === 'past_due' || d.state.status === 'payment_action_required') {
      return <Banner tone="danger" role="alert" title={d.state.status === 'past_due' ? 'A payment failed' : 'Your bank needs you to confirm a payment'}
        actions={d.actions.portal ? <Button size="sm" variant="primary" onClick={onPortal}>Update payment details</Button> : null}>
        Everything keeps working until {day(d.state.grace_ends_at)}. After that, paid actions pause.</Banner>;
    }
    return null;
  }
  const payment = ['past_due', 'payment_action_required', 'incomplete'].includes(d.state.status);
  return (
    <Banner tone={d.state.access === 'suspended' ? 'danger' : 'warn'} role="alert" title={d.state.access_reason ?? 'Paid actions are paused'}
      actions={payment && d.actions.portal ? <Button size="sm" variant="primary" onClick={onPortal}>Update payment details</Button>
        : d.state.access === 'restricted' && d.can_manage ? <Button size="sm" variant="primary" onClick={() => document.getElementById('choose-plan')?.scrollIntoView({ behavior: 'smooth' })}>Choose a plan</Button> : null}>
      Your content, settings and exports stay available. Billing and support always work.
    </Banner>
  );
}

function PlanCard({ d, onChanged }: { d: BillingOverviewDto; onChanged: () => unknown }) {
  const toast = useToast();
  const [change, setChange] = useState(false);
  const [cancel, setCancel] = useState(false);
  const s = d.state;
  const pm = d.payment_method;
  const facts: Array<[string, ReactNode]> = [];
  facts.push(['Status', <Badge key="s" tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>]);
  if (d.trial && s.status === 'trialing') facts.push(['Trial ends', <span key="t">{day(d.trial.ends_at)} · {d.trial.days_left} {d.trial.days_left === 1 ? 'day' : 'days'} left</span>]);
  if (d.first_charge_at) facts.push(['First charge', day(d.first_charge_at)]);
  else if (d.next_charge_at) facts.push(['Renews', day(d.next_charge_at)]);
  if (s.cancel_at) facts.push(['Service ends', day(s.cancel_at)]);
  if (d.plan && d.plan.id !== 'legacy') facts.push(['Seats', <span key="seats">{seatsLabel(d.seats.paid || d.seats.billable)} · {usersLabel(d.seats.billable)}</span>]);
  if (d.recurring_total_minor != null) facts.push(['Monthly total', <span key="m" className="tabular">{money(d.recurring_total_minor)} <span className="text-muted">excl. any tax shown at checkout</span></span>]);
  if (d.scheduled_change) facts.push(['Scheduled', <span key="sc">{[d.scheduled_change.plan_name, d.scheduled_change.seats ? seatsLabel(d.scheduled_change.seats) : null].filter(Boolean).join(' · ')} from {day(d.scheduled_change.effective_at)}</span>]);
  facts.push(['Payment method', pm ? <span key="pm" className="inline-flex items-center gap-1.5"><CreditCard aria-hidden className="size-4 text-muted" />{pm.brand} •••• {pm.last4}{pm.exp_month ? ` · ${String(pm.exp_month).padStart(2, '0')}/${String(pm.exp_year).slice(-2)}` : ''}</span> : <span className="text-muted">{s.status === 'trialing' && !d.first_charge_at ? 'Not needed for the trial' : 'None'}</span>]);

  const portal = async (flow: 'payment_method_update' | null) => {
    try { window.location.assign((await api.post<{ url: string }>('/api/billing/portal', { flow })).url); } catch (e) { toast.error((e as Error).message); }
  };
  return (
    <Card data-testid="billing-plan">
      <CardHeader title="Plan" actions={d.plan?.version && d.plan.id !== 'legacy' ? <MetaChip>v{d.plan.version}</MetaChip> : null} />
      <div className="flex flex-col gap-4 px-4 pb-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-[22px] font-semibold tracking-[-0.01em]">{d.plan?.name ?? 'No plan'}</p>
          {d.plan?.unit_amount_minor != null ? <p className="text-sm text-muted tabular">{money(d.plan.unit_amount_minor)} per user / month</p> : null}
          {d.plan?.id === 'legacy' ? <p className="text-sm text-muted">Your existing access, unchanged</p> : null}
        </div>
        <Facts items={facts} />
        {d.can_manage ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {d.actions.change_subscription ? <Button variant="primary" className="w-full sm:w-auto" onClick={() => setChange(true)}>Change plan or seats</Button> : null}
            {d.actions.portal ? <Button className="w-full sm:w-auto" icon={<CreditCard aria-hidden className="size-4" />} onClick={() => void portal('payment_method_update')}>Update payment details</Button> : null}
            {d.actions.reactivate ? <Button variant="primary" className="w-full sm:w-auto" onClick={async () => { try { await api.post('/api/billing/reactivate', {}); toast.success('Renewal resumed'); await onChanged(); } catch (e) { toast.error((e as Error).message); } }}>Resume renewal</Button> : null}
            {d.scheduled_change && d.actions.change_subscription ? <Button variant="ghost" className="w-full sm:w-auto" onClick={async () => { try { await api.del('/api/billing/change'); toast.success('Scheduled change removed'); await onChanged(); } catch (e) { toast.error((e as Error).message); } }}>Keep current plan</Button> : null}
            {d.actions.cancel ? <Button variant="ghost" className="w-full sm:w-auto sm:ml-auto" onClick={() => setCancel(true)}>Cancel renewal</Button> : null}
          </div>
        ) : <ManageHint />}
      </div>
      {change ? <ChangeDialog d={d} onClose={() => setChange(false)} onDone={onChanged} /> : null}
      <ConfirmDialog open={cancel} onOpenChange={setCancel} title="Cancel renewal?" confirmLabel="Cancel renewal" confirmVariant="danger"
        onConfirm={async () => { await api.post('/api/billing/cancel', {}); toast.success('Renewal cancelled'); await onChanged(); }}>
        <ul className="list-disc space-y-1 pl-5 text-[13px]">
          <li>Your plan stays active until {day(d.next_charge_at ?? d.state.current_period?.end)}. No further charges.</li>
          <li>After that, publishing, AI and other paid actions pause. Scheduled posts are held, not deleted.</li>
          <li>Your content, settings and exports are kept. You can resume or resubscribe any time.</li>
        </ul>
      </ConfirmDialog>
    </Card>
  );
}

function SeatStepper({ value, min, onChange, label = 'Seats' }: { value: number; min: number; onChange: (n: number) => void; label?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[13px] text-muted">{label}</span>
      <div className="inline-flex items-center rounded-lg border border-border">
        <button type="button" aria-label="Fewer seats" className="touch-target grid size-10 place-items-center disabled:opacity-40" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}><Minus aria-hidden className="size-4" /></button>
        <input aria-label={label} inputMode="numeric" className="h-10 w-14 border-x border-border bg-transparent text-center text-sm tabular" value={value}
          onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, '')); if (Number.isFinite(n)) onChange(Math.max(min, Math.min(10000, n || min))); }} />
        <button type="button" aria-label="More seats" className="touch-target grid size-10 place-items-center" onClick={() => onChange(Math.min(10000, value + 1))}><Plus aria-hidden className="size-4" /></button>
      </div>
    </div>
  );
}

function ChoosePlan({ d, onChanged }: { d: BillingOverviewDto; onChanged: () => unknown }) {
  const toast = useToast();
  const minSeats = Math.max(1, d.seats.billable);
  const [seats, setSeats] = useState(minSeats);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const trialRunning = d.state.status === 'trialing' && !!d.trial && d.trial.days_left > 0;
  const go = async (plan: PlanId) => {
    setBusy(plan); setErr(null);
    try {
      if (d.actions.start_trial) {
        await api.post('/api/billing/trial', { plan });
        toast.success('Free trial started'); await onChanged(); setBusy(null);
        return;
      }
      const r = await api.post<{ url: string }>('/api/billing/checkout', { plan, seats });
      window.location.assign(r.url);
    } catch (e) { setErr(e); setBusy(null); }
  };
  const switchTrial = async (plan: PlanId) => {
    setBusy(`trial-${plan}`); setErr(null);
    try { await api.post('/api/billing/trial/plan', { plan }); toast.success('Trial plan changed'); await onChanged(); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  return (
    <section id="choose-plan" aria-labelledby="choose-plan-h" className="flex flex-col gap-3" data-testid="billing-choose">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="choose-plan-h" className="text-[14px] font-semibold">{d.actions.start_trial ? 'Start your free trial' : trialRunning ? 'Subscribe' : 'Choose a plan'}</h2>
        {!d.actions.start_trial ? <SeatStepper value={seats} min={minSeats} onChange={setSeats} /> : null}
      </div>
      {trialRunning && !d.actions.start_trial ? <p className="text-[13px] text-muted">You keep your free trial: the first charge is on {day(d.trial!.ends_at)}.</p> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {d.catalogue.map((p) => {
          const current = d.plan?.id === p.id;
          const total = p.unit_amount_minor * seats;
          return (
            <Card key={p.id} as="article" className={cn('flex flex-col gap-3 p-4', current && 'border-accent')} data-testid={`plan-${p.id}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-[16px] font-semibold">{p.name}</h3>
                  <p className="text-[13px] text-muted">{p.summary}</p>
                </div>
                {current && trialRunning ? <Badge tone="accent">Trial</Badge> : null}
              </div>
              <p className="tabular"><span className="text-[22px] font-semibold">{money(p.unit_amount_minor)}</span> <span className="text-[13px] text-muted">per user / month</span></p>
              <ul className="flex flex-col gap-1 text-[13px]">{p.highlights.slice(0, 4).map((h) => <li key={h}>· {h}</li>)}</ul>
              <div className="mt-auto flex flex-col gap-2">
                {!d.actions.start_trial ? <p className="text-[13px] tabular" data-testid={`plan-${p.id}-total`}>{usersLabel(seats)} × {money(p.unit_amount_minor)} = <strong>{money(total)}</strong> / month</p> : <p className="text-[13px] text-muted">{p.trial_days} days free · no card</p>}
                <Button variant={current || d.actions.start_trial ? 'primary' : 'secondary'} loading={busy === p.id} disabled={!!busy || (!d.actions.start_trial && !d.actions.checkout)}
                  disabledReason={!d.actions.start_trial && !d.actions.checkout ? 'Payments are not set up yet' : null} onClick={() => void go(p.id as PlanId)}>
                  {d.actions.start_trial ? 'Start free trial' : 'Continue to checkout'}
                </Button>
                {d.actions.change_trial_plan && !current ? <Button variant="ghost" size="sm" loading={busy === `trial-${p.id}`} disabled={!!busy} onClick={() => void switchTrial(p.id as PlanId)}>Switch trial to {p.name}</Button> : null}
              </div>
            </Card>
          );
        })}
      </div>
      {err ? <ErrorNotice error={err} /> : null}
      {!d.actions.start_trial ? <p className="text-xs text-muted">Payment is collected on the provider’s secure page. Relay never sees your card.</p> : null}
    </section>
  );
}

function ChangeDialog({ d, onClose, onDone }: { d: BillingOverviewDto; onClose: () => void; onDone: () => unknown }) {
  const toast = useToast();
  const minSeats = Math.max(1, d.seats.billable);
  const [plan, setPlan] = useState<PlanId>((d.plan?.id === 'professional' ? 'professional' : 'standard'));
  const [seats, setSeats] = useState(Math.max(minSeats, d.seats.paid));
  const [preview, setPreview] = useState<BillingChangePreviewDto | null>(null);
  const [perr, setPerr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const unchanged = plan === d.plan?.id && seats === d.seats.paid;
  useEffect(() => {
    if (unchanged) return;
    let live = true;
    const t = setTimeout(async () => {
      setPerr(null); setPreview(null);
      try { const p = await api.post<BillingChangePreviewDto>('/api/billing/preview', { plan, seats }); if (live) setPreview(p); } catch (e) { if (live) { setPreview(null); setPerr(e); } }
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [plan, seats, unchanged]);
  const key = useMemo(() => `${plan}-${seats}-${crypto.randomUUID()}`, [plan, seats]);
  const confirm = async () => {
    if (!preview) return;
    setBusy(true); setErr(null);
    try {
      await api.post('/api/billing/change', { plan, seats, proration_date: preview.proration_date, expected_version: d.version }, { idempotent: key });
      toast.success(preview.kind === 'scheduled' ? 'Change scheduled' : 'Plan updated');
      await onDone(); onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Change plan or seats" busy={busy}
      footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" loading={busy} disabled={unchanged || !preview || preview.kind === 'none'} onClick={() => void confirm()}>
        {preview?.kind === 'scheduled' ? 'Schedule change' : 'Confirm change'}</Button></>}>
      <div className="flex flex-col gap-4">
        <div role="radiogroup" aria-label="Plan" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {d.catalogue.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={plan === p.id} onClick={() => setPlan(p.id as PlanId)}
              className={cn('touch-target flex flex-col items-start rounded-lg border px-3 py-2 text-left', plan === p.id ? 'border-accent bg-accent-soft' : 'border-border hover:bg-raised')}>
              <span className="text-sm font-medium">{p.name}</span><span className="text-xs text-muted tabular">{money(p.unit_amount_minor)} per user / month</span>
            </button>
          ))}
        </div>
        <SeatStepper value={seats} min={minSeats} onChange={setSeats} />
        <p className="text-xs text-muted">{usersLabel(d.seats.billable)} in the workspace — seats can’t go below that.</p>
        {unchanged ? <p className="text-[13px] text-muted">Pick a different plan or number of seats.</p> : perr ? <ErrorNotice error={perr} /> : !preview ? <Spinner label="Asking the payment provider" /> : (
          <div className="rounded-lg border border-border p-3 text-[13px]" data-testid="billing-preview">
            <Facts items={[
              ['New monthly total', <strong key="t" className="tabular">{money(preview.to.recurring_minor)}</strong>],
              ['Now', <span key="n" className="tabular">{money(preview.from.recurring_minor)} / month</span>],
              ['When', preview.kind === 'scheduled' ? `From ${day(preview.effective_at)}` : 'Now'],
              ...(preview.kind === 'immediate' && preview.proration_minor ? [['Prorated now', <span key="p" className="tabular">{money(preview.proration_minor)} on your next invoice</span>] as [string, ReactNode]] : []),
              ...(preview.next_invoice_minor != null ? [['Next invoice', <span key="ni" className="tabular">{money(preview.next_invoice_minor)}{preview.next_invoice_at ? ` on ${day(preview.next_invoice_at)}` : ''}</span>] as [string, ReactNode]] : []),
            ]} />
            {preview.notes.length ? <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">{preview.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
          </div>
        )}
        {err ? <ErrorNotice error={err} /> : null}
      </div>
    </Dialog>
  );
}

function SeatsCard({ d }: { d: BillingOverviewDto }) {
  if (d.state.status === 'legacy' && !d.seats.billable) return null;
  const s = d.seats;
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><Users aria-hidden className="size-4 text-muted" />People</span>} />
      <div className="px-4 pb-4">
        <Facts items={[
          ['Billable users', <span key="b" className="tabular">{s.billable}</span>],
          ...(s.free_guests ? [['Free guests', <span key="g" className="tabular">{s.free_guests} (up to 5)</span>] as [string, ReactNode]] : []),
          ...(s.billable_guests ? [['Guests over the free limit', <span key="bg" className="tabular">{s.billable_guests}</span>] as [string, ReactNode]] : []),
          ...(s.pending_member_invites ? [['Pending invitations', <span key="p" className="tabular">{s.pending_member_invites}</span>] as [string, ReactNode]] : []),
          ...(s.support_operators ? [['Relay support (not billed)', <span key="o" className="tabular">{s.support_operators}</span>] as [string, ReactNode]] : []),
        ]} />
        {d.state.status !== 'legacy' && s.paid > 0 && s.paid < s.billable + s.pending_member_invites ? (
          <p className="mt-3 text-xs text-muted">All paid seats are in use. Add seats with “Change plan or seats” before inviting more people.</p>
        ) : null}
      </div>
    </Card>
  );
}

function InvoicesCard({ d }: { d: BillingOverviewDto }) {
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><Receipt aria-hidden className="size-4 text-muted" />Invoices</span>} />
      {!d.invoices.length ? <EmptyState compact icon={<FileText aria-hidden />} title="No invoices yet" /> : (
        <ul className="divide-y divide-border">
          {d.invoices.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-[13px]" data-testid="billing-invoice">
              <span className="min-w-0 flex-1 truncate font-medium">{i.number ?? 'Draft'}{i.test_mode ? <Badge tone="warn" className="ml-2">Test</Badge> : null}</span>
              <span className="text-muted">{day(i.created_at)}</span>
              <span className="tabular">{money(i.total_minor)}</span>
              <Badge tone={i.status === 'paid' ? 'success' : i.status === 'open' ? 'warn' : 'neutral'}>{i.status}</Badge>
              {i.hosted_url ? <a href={i.hosted_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-accent-text hover:underline">View<ExternalLink aria-hidden className="size-3.5" /></a> : null}
              {i.pdf_url ? <a href={i.pdf_url} target="_blank" rel="noreferrer noopener" className="font-medium text-accent-text hover:underline">PDF</a> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const fmtUnit = (unit: string, n: number) => unit === 'bytes' ? `${(n / 1024 ** 3).toLocaleString('en-GB', { maximumFractionDigits: 1 })} GB` : n.toLocaleString('en-GB');

/** Usage and limits summary from the shared entitlement service (ENT). Hidden when unavailable. */
function UsageCard() {
  const { data } = useApi<EntitlementsDto>('/api/entitlements');
  const metered = (data?.allowances ?? []).filter((a) => a.hard_limit != null).slice(0, 6);
  if (!data || !metered.length) return null;
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><Gauge aria-hidden className="size-4 text-muted" />Usage this period</span>}
        actions={<Link href="/admin/usage" className="text-[13px] font-medium text-accent-text hover:underline">All usage</Link>} />
      <ul className="divide-y divide-border">
        {metered.map((a) => {
          const pct = Math.min(100, a.percent ?? 0);
          return (
            <li key={a.key} className="px-4 py-3 text-[13px]">
              <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="font-medium">{a.label}</span>
                <span className="tabular text-muted">{fmtUnit(a.unit, a.used)} of {fmtUnit(a.unit, a.hard_limit!)}</span></div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-sunken" role="progressbar" aria-label={`${a.label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                <div className={cn('h-full', a.status === 'exhausted' || a.status === 'over_limit' ? 'bg-danger' : a.status === 'warning' ? 'bg-warn' : 'bg-[var(--text)]')} style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** V5 (MKT): a new self-serve owner usually lacks a verified second factor, which billing changes require by the workspace
 *  security policy — say so instead of implying they lack the role. */
function ManageHint() {
  const { session } = useSession();
  const ownerish = session.workspace?.role === 'owner' || session.workspace?.role === 'admin';
  if (ownerish && session.v2 && !session.v2.mfa_verified) {
    return <p className="text-xs text-muted" data-testid="billing-mfa-hint">Billing changes need two-step verification. <Link href="/security" className="font-medium text-accent-text hover:underline">Set it up in Security</Link>, then come back to choose a plan.</p>;
  }
  return <p className="text-xs text-muted">Only people who manage billing can make changes.</p>;
}
