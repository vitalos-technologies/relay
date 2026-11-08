'use client';
// UI of the test-mode hosted pages. Outcomes are delivered to Relay as signed provider events (webhook verification path);
// the page then follows the provider's redirect, which itself proves nothing.
import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { FlaskConical, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { SessionProvider } from '@/lib/client/session';
import { Banner, Button, ErrorNotice, ErrorState, Facts, Spinner } from '@/components/ui';
import { day, money, seatsLabel } from './format';

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-start justify-center bg-sunken px-4 py-10 sm:items-center">
      <div className="w-full max-w-[460px]">
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-warn bg-warn-soft px-3 py-2 text-[13px]" role="note">
          <FlaskConical aria-hidden className="size-4 shrink-0" /><span><strong>Test mode.</strong> This stands in for the payment provider’s page. No real payment is taken.</span>
        </div>
        <section className="rounded-2xl border border-border bg-surface p-6 sm:p-8">
          <h1 className="text-[20px] font-semibold">{title}</h1>
          {children}
        </section>
      </div>
    </main>
  );
}

const useSessionParam = () => useSearchParams().get('session') ?? '';

interface CheckoutSummary { session: string; status: string; workspace: string; plan: { id: string; name: string; unit_amount_minor: number | null } | null; seats: number; recurring_minor: number; due_today_minor: number; first_charge_at: string | null; expires_at: string; cancel_url: string }

export function TestCheckoutPage() {
  return <SessionProvider fallback={<Shell title="Checkout"><Spinner label="Loading" /></Shell>} renderError={(e, r) => <Shell title="Checkout"><ErrorState error={e} onRetry={r} /></Shell>}><TestCheckout /></SessionProvider>;
}

function TestCheckout() {
  const session = useSessionParam();
  const { data, error, refetch } = useApi<CheckoutSummary>(session ? `/api/billing/test/checkout?session=${encodeURIComponent(session)}` : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const act = async (outcome: 'paid' | 'declined' | 'requires_action' | 'cancel') => {
    setBusy(outcome); setErr(null);
    try { const r = await api.post<{ redirect: string }>('/api/billing/test/checkout', { session, outcome }); window.location.assign(r.redirect); } catch (e) { setErr(e); setBusy(null); }
  };
  if (error && !data) return <Shell title="Checkout"><ErrorState error={error} onRetry={refetch} /></Shell>;
  if (!data) return <Shell title="Checkout"><Spinner label="Loading" /></Shell>;
  return (
    <Shell title={`Subscribe to ${data.plan?.name ?? 'Relay'}`}>
      <p className="mt-1 text-[13px] text-muted">{data.workspace}</p>
      <Facts className="mt-5" items={[
        ['Plan', `${data.plan?.name ?? '—'} · ${money(data.plan?.unit_amount_minor)} per user / month`],
        ['Seats', seatsLabel(data.seats)],
        ['Monthly', <strong key="m" className="tabular">{money(data.recurring_minor)}</strong>],
        ['Due today', <span key="d" className="tabular">{money(data.due_today_minor)}</span>],
        ...(data.first_charge_at ? [['First charge', day(data.first_charge_at)] as [string, ReactNode]] : []),
      ]} />
      {data.status !== 'open' ? <Banner tone="neutral" className="mt-5" title="This checkout is closed" /> : (
        <div className="mt-6 flex flex-col gap-2" data-testid="test-checkout-actions">
          <Button variant="primary" size="lg" icon={<ShieldCheck aria-hidden className="size-4" />} loading={busy === 'paid'} disabled={!!busy} onClick={() => void act('paid')}>Pay with test card •••• 4242</Button>
          <Button loading={busy === 'requires_action'} disabled={!!busy} onClick={() => void act('requires_action')}>Simulate bank authentication</Button>
          <Button loading={busy === 'declined'} disabled={!!busy} onClick={() => void act('declined')}>Simulate a declined card</Button>
          <Button variant="ghost" loading={busy === 'cancel'} disabled={!!busy} onClick={() => void act('cancel')}>Cancel and return to Relay</Button>
        </div>
      )}
      {err ? <ErrorNotice error={err} className="mt-4" /> : null}
    </Shell>
  );
}

interface PortalSummary { session: string; flow: string | null; return_url: string; plan: string; status: string; seats: number; cancel_at_period_end: boolean; current_period_end: string | null; payment_method: { brand: string; last4: string } | null; has_subscription: boolean }

export function TestPortalPage() {
  return <SessionProvider fallback={<Shell title="Billing"><Spinner label="Loading" /></Shell>} renderError={(e, r) => <Shell title="Billing"><ErrorState error={e} onRetry={r} /></Shell>}><TestPortal /></SessionProvider>;
}

function TestPortal() {
  const session = useSessionParam();
  const { data, error, refetch } = useApi<PortalSummary>(session ? `/api/billing/test/portal?session=${encodeURIComponent(session)}` : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const act = async (action: string, label: string) => {
    setBusy(action); setErr(null);
    try { await api.post('/api/billing/test/portal', { session, action }); setDone(label); await refetch(); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  if (error && !data) return <Shell title="Billing"><ErrorState error={error} onRetry={refetch} /></Shell>;
  if (!data) return <Shell title="Billing"><Spinner label="Loading" /></Shell>;
  return (
    <Shell title="Manage billing">
      <Facts className="mt-5" items={[
        ['Plan', `${data.plan} · ${seatsLabel(data.seats)}`],
        ['Renewal', data.cancel_at_period_end ? `Cancelled · ends ${day(data.current_period_end)}` : `Renews ${day(data.current_period_end)}`],
        ['Card', data.payment_method ? `${data.payment_method.brand} •••• ${data.payment_method.last4}` : 'None'],
      ]} />
      {done ? <Banner tone="success" className="mt-4" title={done} /> : null}
      <div className="mt-6 flex flex-col gap-2" data-testid="test-portal-actions">
        <Button variant={data.flow === 'payment_method_update' ? 'primary' : 'secondary'} loading={busy === 'update_card'} disabled={!!busy} onClick={() => void act('update_card', 'Card updated')}>Update card (test Mastercard •••• 4444)</Button>
        {data.has_subscription ? (data.cancel_at_period_end
          ? <Button loading={busy === 'resume'} disabled={!!busy} onClick={() => void act('resume', 'Renewal resumed')}>Resume renewal</Button>
          : <Button loading={busy === 'cancel'} disabled={!!busy} onClick={() => void act('cancel', 'Renewal cancelled')}>Cancel renewal</Button>) : null}
      </div>
      {data.has_subscription ? (
        <details className="mt-5 text-[13px]">
          <summary className="cursor-pointer text-muted">Simulate provider events</summary>
          <div className="mt-3 flex flex-col gap-2">
            <Button size="sm" loading={busy === 'renew'} disabled={!!busy} onClick={() => void act('renew', 'Period renewed')}>Renew now</Button>
            <Button size="sm" loading={busy === 'fail_payment'} disabled={!!busy} onClick={() => void act('fail_payment', 'Renewal payment failed')}>Fail the next payment</Button>
            <Button size="sm" loading={busy === 'require_action'} disabled={!!busy} onClick={() => void act('require_action', 'Bank authentication requested')}>Ask for bank authentication</Button>
            <Button size="sm" loading={busy === 'recover'} disabled={!!busy} onClick={() => void act('recover', 'Payment recovered')}>Pay the open invoice</Button>
          </div>
        </details>
      ) : null}
      {err ? <ErrorNotice error={err} className="mt-4" /> : null}
      <a href={data.return_url} className="mt-6 inline-flex text-[13px] font-medium text-accent-text hover:underline" data-testid="test-portal-return">Return to Relay</a>
    </Shell>
  );
}
