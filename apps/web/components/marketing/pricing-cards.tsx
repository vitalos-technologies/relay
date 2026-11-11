'use client';
// Pricing cards + team-size estimate (brief §5: show seats and the recurring total before purchase). Prices and totals come
// from the shared catalogue functions (recurringTotalMinor / formatMinorGBP) — the same ones checkout and Billing use.
// Card layout (user request 2026-11-11, after a reference template, light only): name (+ outlined badge on the highlighted
// plan), large price with a small suffix, one-line summary, full-width CTA (filled on the highlighted plan), the seat total,
// a hairline, then five checklist lines from the catalogue (plan-data `cardChecklist`). No monthly/yearly switch: Relay bills
// monthly only. The team-size stepper sits centred above the cards, where such a switch would be.
// D33: Free (£0) is one user with no trial, so the estimate applies to the paid plans only.
// The estimate is carried to /signup?plan=…&seats=… for display only; checkout charges for the billable users at that time.
import { useState } from 'react';
import { Check, Minus, Plus } from 'lucide-react';
import { formatMinorGBP, recurringTotalMinor, type PublicPlanId } from '@social-lite/core/contracts/v4-plans';
import { buttonVariants } from '@/components/ui-v5/button';
import { cn } from '@/components/ui-v5/cn';
import { Reveal } from '@/components/ui-v5/reveal';

export interface CardPlan { id: PublicPlanId; name: string; summary: string; price: string; free: boolean; checklist: readonly string[] }
export const MAX_ESTIMATE_SEATS = 500;

const step = 'inline-flex size-9 items-center justify-center rounded-full text-v5-fg outline-none hover:bg-v5-raised focus-visible:outline-2 focus-visible:outline-v5-ring disabled:opacity-40 touch-target';

export function PricingCards({ plans, trialDays, noCard }: { plans: CardPlan[]; trialDays: number; noCard: boolean }) {
  const [seats, setSeats] = useState(3);
  const set = (n: number) => setSeats(Math.max(1, Math.min(MAX_ESTIMATE_SEATS, Math.round(Number.isFinite(n) ? n : 1))));
  const users = (n: number) => `${n} ${n === 1 ? 'user' : 'users'}`;
  return (
    <div className="flex flex-col gap-8 sm:gap-10">
      <div className="mx-auto flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-full max-[359px]:rounded-2xl border border-[var(--mkt-tile-border)] bg-[var(--mkt-tile)] py-1 pl-5 pr-4" data-testid="mkt-seat-control">
        <label htmlFor="mkt-seats" className="text-[14px] font-semibold text-v5-fg">Team size</label>
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={() => set(seats - 1)} disabled={seats <= 1} aria-label="One user fewer" className={step}><Minus aria-hidden className="size-4" /></button>
          <input id="mkt-seats" type="number" inputMode="numeric" min={1} max={MAX_ESTIMATE_SEATS} value={seats} onChange={(e) => set(Number(e.target.value))} aria-describedby="mkt-seats-hint"
            className="h-9 w-14 rounded-lg border border-[var(--mkt-tile-border)] bg-v5-surface text-center text-[15px] font-semibold tabular-nums text-v5-fg outline-none focus-visible:outline-2 focus-visible:outline-v5-ring" data-testid="mkt-seats" />
          <button type="button" onClick={() => set(seats + 1)} disabled={seats >= MAX_ESTIMATE_SEATS} aria-label="One user more" className={step}><Plus aria-hidden className="size-4" /></button>
        </div>
        <span id="mkt-seats-hint" className="text-[14px] text-v5-muted">{seats === 1 ? 'user' : 'users'}<span className="max-[419px]:sr-only"> · paid plans</span></span>
      </div>
      <ul className="mx-auto grid w-full max-w-[1120px] grid-cols-1 gap-5 md:max-w-[560px] lg:max-w-[1120px] lg:grid-cols-3" data-testid="mkt-plans">
        {plans.map((p, i) => {
          const featured = i === plans.length - 1;
          const total = formatMinorGBP(recurringTotalMinor(p.id, p.free ? 1 : seats));
          return (
            <Reveal as="li" key={p.id} effect="rise" delay={i * 0.1} data-testid={`mkt-plan-${p.id}`}>
              <div className={cn('mkt-lift flex h-full flex-col rounded-[20px] border p-6 sm:p-8',
                featured ? 'border-[color-mix(in_srgb,var(--v5-primary-text)_35%,transparent)] bg-v5-surface shadow-[var(--mkt-shadow)]' : 'border-[var(--mkt-tile-border)] bg-[var(--mkt-tile)]')}>
                <div className="flex min-h-8 items-center justify-between gap-3">
                  <h3 className="text-[24px] font-semibold leading-tight tracking-[-0.02em] text-v5-fg">{p.name}</h3>
                  {featured ? <span className="rounded-md border border-[color-mix(in_srgb,var(--v5-primary-text)_55%,transparent)] px-2 py-1 text-[11px] font-semibold uppercase leading-none tracking-[0.08em] text-v5-primary-text">All features</span> : null}
                </div>
                <p className="mt-5 flex items-baseline gap-2">
                  <span className="text-[48px] font-semibold leading-none tracking-[-0.04em] text-v5-fg" data-testid={`mkt-price-${p.id}`}>{p.price}</span>
                  <span className="text-[14px] text-v5-muted">{p.free ? 'for 1 user' : 'per user / month'}</span>
                </p>
                <p className="mt-4 text-[15px] leading-snug text-v5-muted lg:min-h-[2lh]">{p.summary}</p>
                <p className="mt-3 flex min-h-[26px] flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                  {p.free ? null : <span className="rounded-full bg-v5-primary-soft px-2.5 py-0.5 font-semibold text-v5-primary-text">{trialDays} days free</span>}
                  {noCard || p.free ? <span className="text-v5-muted">No card required</span> : null}
                </p>
                <a href={p.free ? `/signup?plan=${p.id}` : `/signup?plan=${p.id}&seats=${seats}`} className={cn(buttonVariants({ variant: featured ? 'primary' : 'outline', shape: 'rounded' }), 'mt-6 h-11 w-full text-[15px]')} data-testid={`mkt-cta-${p.id}`}>
                  {p.free ? 'Start free' : 'Start free trial'}<span className="sr-only"> on {p.name}</span>
                </a>
                <p className="mt-3 text-center text-[13px] text-v5-muted" aria-live={p.free ? undefined : 'polite'} data-testid={`mkt-total-${p.id}`}>
                  <span className="font-semibold tabular-nums text-v5-fg">{users(p.free ? 1 : seats)} · {total} / month</span>{' '}
                  {p.free ? 'no teammates' : 'after the trial'}
                </p>
                <hr className="my-6 border-0 border-t border-[var(--mkt-tile-border)]" />
                <ul className={cn('flex flex-col gap-3 text-[15px]', featured ? 'font-medium text-v5-fg' : 'text-v5-muted')}>
                  {p.checklist.map((h) => (
                    <li key={h} className="flex gap-2.5">
                      <Check aria-hidden strokeWidth={featured ? 2.5 : 2} className={cn('mt-[3px] size-4 shrink-0', featured ? 'text-v5-primary-text' : 'text-[var(--mkt-glyph)]')} />{h}
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          );
        })}
      </ul>
    </div>
  );
}
