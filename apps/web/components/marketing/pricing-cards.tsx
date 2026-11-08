'use client';
// Pricing cards + team-size estimate (brief §5: show seats and the recurring total before purchase). Prices and totals come
// from the shared catalogue functions (recurringTotalMinor / formatMinorGBP) — the same ones checkout and Billing use.
// The estimate is carried to /signup?plan=…&seats=… for display only; checkout charges for the billable users at that time.
import { useState } from 'react';
import { Check, Minus, Plus } from 'lucide-react';
import { formatMinorGBP, recurringTotalMinor, type PublicPlanId } from '@social-lite/core/contracts/v4-plans';
import { buttonVariants } from '@/components/ui-v5/button';
import { cn } from '@/components/ui-v5/cn';

export interface CardPlan { id: PublicPlanId; name: string; summary: string; price: string; highlights: readonly string[] }
export const MAX_ESTIMATE_SEATS = 500;

export function PricingCards({ plans, trialDays, noCard }: { plans: CardPlan[]; trialDays: number; noCard: boolean }) {
  const [seats, setSeats] = useState(3);
  const set = (n: number) => setSeats(Math.max(1, Math.min(MAX_ESTIMATE_SEATS, Math.round(Number.isFinite(n) ? n : 1))));
  return (
    <div className="flex flex-col gap-6">
      <div className="mx-auto flex flex-wrap items-center justify-center gap-3 rounded-full border border-v5-border bg-v5-surface px-4 py-2">
        <label htmlFor="mkt-seats" className="text-[14px] font-semibold text-v5-fg">Team size</label>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => set(seats - 1)} disabled={seats <= 1} aria-label="One user fewer" className="inline-flex size-10 items-center justify-center rounded-full text-v5-fg outline-none hover:bg-v5-raised focus-visible:outline-2 focus-visible:outline-v5-ring disabled:opacity-40"><Minus aria-hidden className="size-4" /></button>
          <input id="mkt-seats" type="number" inputMode="numeric" min={1} max={MAX_ESTIMATE_SEATS} value={seats} onChange={(e) => set(Number(e.target.value))}
            className="h-10 w-16 rounded-lg border border-v5-border bg-v5-bg text-center text-[15px] font-semibold tabular-nums text-v5-fg outline-none focus-visible:outline-2 focus-visible:outline-v5-ring" data-testid="mkt-seats" />
          <button type="button" onClick={() => set(seats + 1)} disabled={seats >= MAX_ESTIMATE_SEATS} aria-label="One user more" className="inline-flex size-10 items-center justify-center rounded-full text-v5-fg outline-none hover:bg-v5-raised focus-visible:outline-2 focus-visible:outline-v5-ring disabled:opacity-40"><Plus aria-hidden className="size-4" /></button>
        </div>
        <span className="text-[14px] text-v5-muted">{seats === 1 ? 'user' : 'users'}</span>
      </div>
      <ul className="mx-auto grid w-full max-w-[920px] grid-cols-1 gap-6 md:grid-cols-2" data-testid="mkt-plans">
        {plans.map((p, i) => {
          const featured = i === plans.length - 1;
          const total = formatMinorGBP(recurringTotalMinor(p.id, seats));
          return (
            <li key={p.id} data-testid={`mkt-plan-${p.id}`} className={cn('relative flex flex-col gap-5 rounded-[24px] border bg-v5-surface p-6 sm:p-8', featured ? 'border-2 border-v5-primary-text shadow-[var(--mkt-shadow)]' : 'border-v5-border')}>
              {featured ? <span className="absolute -top-3 left-6 rounded-full bg-v5-primary px-3 py-1 text-[12px] font-semibold text-v5-on-primary">All features</span> : null}
              <div>
                <h3 className="text-[22px] font-bold tracking-[-0.01em] text-v5-fg">{p.name}</h3>
                <p className="mt-1 text-[15px] text-v5-muted">{p.summary}</p>
              </div>
              <div>
                <p className="flex items-baseline gap-2"><span className="text-[44px] font-extrabold leading-none tracking-[-0.03em] text-v5-fg" data-testid={`mkt-price-${p.id}`}>{p.price}</span><span className="text-[15px] text-v5-muted">per user / month</span></p>
                <p className="mt-3 flex flex-wrap items-center gap-2 text-[14px]">
                  <span className="rounded-full bg-v5-primary-soft px-2.5 py-0.5 font-semibold text-v5-primary-text">{trialDays} days free</span>
                  {noCard ? <span className="text-v5-muted">No card required</span> : null}
                </p>
              </div>
              <p className="rounded-xl bg-v5-raised px-3 py-2 text-[14px] text-v5-fg" aria-live="polite" data-testid={`mkt-total-${p.id}`}>
                <span className="font-semibold tabular-nums">{seats} {seats === 1 ? 'user' : 'users'} · {total} / month</span> <span className="text-v5-muted">after the trial</span>
              </p>
              <ul className="flex flex-col gap-2.5 text-[15px] text-v5-fg">
                {p.highlights.map((h) => <li key={h} className="flex gap-2.5"><Check aria-hidden className="mt-0.5 size-4.5 shrink-0 text-v5-primary-text" />{h}</li>)}
              </ul>
              <a href={`/signup?plan=${p.id}&seats=${seats}`} className={cn(buttonVariants({ variant: featured ? 'primary' : 'outline', size: 'lg' }), 'mt-auto w-full')} data-testid={`mkt-cta-${p.id}`}>
                Start free trial<span className="sr-only"> on {p.name}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
