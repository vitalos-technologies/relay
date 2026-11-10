// /signup?plan=free|standard|professional — selected-plan handoff from the marketing page (V5 §8, D33). Public. Shows the
// chosen plan from the shared catalogue: Free (£0, one user, no trial) or a paid plan with its 14-day no-card trial and the
// seats × price estimate. Next: sign in / register → create workspace (Free, or the trial on the paid plan).
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowRight, Check } from 'lucide-react';
import { publicCatalogue, TRIAL_DAYS, type PublicPlanId } from '@social-lite/core/contracts/v4-plans';
import { RelayWordmark } from '@/components/brand/relay-mark';
import { money } from '@/components/billing/format';
import { SeatTotal } from '@/components/marketing/seat-total';

export const dynamic = 'force-dynamic';

type SP = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
function selectedPlan(raw: string | undefined) {
  const plans = publicCatalogue();
  return { plans, selected: plans.find((p) => p.id === raw) ?? plans.find((p) => p.id === 'standard')! };
}

export async function generateMetadata({ searchParams }: { searchParams: SP }): Promise<Metadata> {
  const { selected } = selectedPlan(first((await searchParams).plan));
  return { title: selected.unit_amount_minor === 0 ? `Start on ${selected.name}` : 'Start your free trial' };
}

export default async function SignupPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const { plans, selected: selectedPlanEntry } = selectedPlan(first(sp.plan));
  const selected = selectedPlanEntry.id as PublicPlanId;
  const isFree = selectedPlanEntry.unit_amount_minor === 0;
  // V5: team size carried from the marketing pricing estimate (display only; clamped). Paid plans only.
  const rawSeats = Number(first(sp.seats));
  const seats = Number.isInteger(rawSeats) && rawSeats >= 1 ? Math.min(rawSeats, 500) : 1;
  return (
    <main className="flex min-h-dvh items-start justify-center px-4 py-10 sm:items-center">
      <div className="w-full max-w-[880px]">
        <div className="mb-8"><RelayWordmark size={30} /></div>
        <h1 className="text-[26px] font-semibold tracking-[-0.01em]" data-testid="signup-title">{isFree ? `Start on ${selectedPlanEntry.name}` : `Start your ${TRIAL_DAYS}-day free trial`}</h1>
        <p className="mt-1 text-sm text-muted">{isFree ? 'No card needed. Upgrade any time.' : 'No card needed. Choose a plan when you’re ready.'}</p>
        <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-3" role="list">
          {plans.map((p) => {
            const on = p.id === selected;
            const free = p.unit_amount_minor === 0;
            return (
              <Link key={p.id} role="listitem" href={`/signup?plan=${p.id}${seats > 1 ? `&seats=${seats}` : ''}`} aria-current={on ? 'true' : undefined} data-testid={`signup-plan-${p.id}`}
                className={`flex flex-col gap-2 rounded-2xl border p-5 ${on ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:bg-raised'}`}>
                <span className="flex items-center justify-between">
                  <span className="text-[17px] font-semibold">{p.name}</span>
                  {on ? <Check aria-label="Selected" className="size-5 text-accent-text" /> : null}
                </span>
                <span className="text-[13px] text-muted">{p.summary}</span>
                <span className="tabular"><span className="text-[22px] font-semibold">{money(p.unit_amount_minor)}</span> <span className="text-[13px] text-muted">{free ? 'for 1 user' : 'per user / month after the trial'}</span></span>
                <ul className="mt-1 flex flex-col gap-1 text-[13px]">{p.highlights.slice(0, 4).map((h) => <li key={h}>· {h}</li>)}</ul>
              </Link>
            );
          })}
        </div>
        {isFree ? null : <SeatTotal key={selected} plan={selected} planName={selectedPlanEntry.name} initialSeats={seats} trialDays={TRIAL_DAYS} />}
        <Link href={`/signup/workspace?plan=${selected}`} data-testid="signup-continue"
          className="touch-target mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent text-[15px] font-medium text-on-accent hover:bg-accent-hover sm:w-auto sm:px-6">
          {isFree ? `Continue with ${selectedPlanEntry.name}` : `Start free trial on ${selectedPlanEntry.name}`}<ArrowRight aria-hidden className="size-4" />
        </Link>
        <p className="mt-3 text-xs text-muted">{isFree
          ? 'Next, sign in or create an account and name your workspace. Upgrade from Billing when you need teammates or more.'
          : 'Next, sign in or create an account and name your workspace. When you subscribe, you’re billed per active member; Billing shows the seats and total before you buy. Prices in GBP; any tax is shown at checkout.'}</p>
        <p className="mt-4 text-xs"><Link href="/#pricing" className="font-medium text-accent-text hover:underline">Compare plans</Link></p>
      </div>
    </main>
  );
}
