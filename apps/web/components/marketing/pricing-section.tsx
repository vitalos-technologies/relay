// Pricing (server shell): the three public plans from the shared catalogue (D33: Free £0, Standard and Professional per user
// with a 14-day no-card trial), seat estimate for paid plans, and the expandable feature/allowance comparison. Tax wording matches the configured checkout (no tax claim, D21).
// Header (user request 2026-11-11): centred eyebrow + two-tone heading, as in the integrations section.
import { Check, Minus } from 'lucide-react';
import { Container, Eyebrow, TwoToneHeading } from './section';
import { PricingCards } from './pricing-cards';
import { PlanComparison } from './plan-comparison';
import { Reveal } from '@/components/ui-v5/reveal';
import { TRIAL_DAYS, TRIAL_REQUIRES_CARD, cardChecklist, comparison, pricingPlans } from './plan-data';

export function PricingSection() {
  const plans = pricingPlans();
  const groups = comparison();
  return (
    <section id="pricing" aria-labelledby="pricing-title" className="scroll-mt-20 py-20 sm:py-28">
      <Container className="flex flex-col gap-10 sm:gap-12">
        <Reveal className="flex flex-col items-center gap-5 text-center">
          <Eyebrow>Pricing</Eyebrow>
          <TwoToneHeading id="pricing-title" lines={['Start free.', 'Pay per user as you grow.']} />
        </Reveal>
        <PricingCards plans={plans.map((p) => ({ id: p.id, name: p.name, summary: p.summary, price: p.price, free: p.free, checklist: cardChecklist(p.id) }))} trialDays={TRIAL_DAYS} noCard={!TRIAL_REQUIRES_CARD} />
        <p className="mx-auto max-w-[760px] text-balance text-center text-[13px] text-v5-muted">Prices in GBP per active user, billed monthly. Any tax is shown at checkout. Pending invitations and review-only guests aren’t billed. A trial that ends without a subscription moves to Free — nothing is deleted.</p>
        <PlanComparison>
          <div className="relative overflow-x-auto rounded-[20px] border border-[var(--mkt-tile-border)] bg-v5-surface" data-testid="mkt-comparison">
            <table className="w-full min-w-[640px] border-collapse text-left text-[14px]">
              <caption className="sr-only">Plan comparison: features and allowances</caption>
              <thead>
                <tr className="border-b border-[var(--mkt-tile-border)]">
                  <th scope="col" className="p-4 font-semibold text-v5-muted">What’s included</th>
                  {plans.map((p) => <th key={p.id} scope="col" className="w-[22%] p-4 font-bold text-v5-fg">{p.name} <span className="font-normal text-v5-muted">{p.price}</span></th>)}
                </tr>
              </thead>
              {groups.map((g) => (
                <tbody key={g.id}>
                  <tr className="bg-[var(--mkt-tile)]">
                    <th scope="colgroup" colSpan={plans.length + 1} className="px-4 py-2.5 text-[13px] font-bold text-v5-fg">{g.title}{g.note ? <span className="ml-2 font-normal text-v5-muted">{g.note}</span> : null}</th>
                  </tr>
                  {g.rows.map((r) => (
                    <tr key={r.key} className="border-t border-[var(--mkt-tile-border)]">
                      <th scope="row" className="p-4 font-medium text-v5-fg">{r.label}</th>
                      {plans.map((p) => {
                        const v = r.values[p.id];
                        return (
                          <td key={p.id} className="p-4 text-v5-muted">
                            {v === true ? <><Check aria-hidden className="size-4.5 text-v5-primary-text" /><span className="sr-only">Included</span></>
                              : v === false ? <><Minus aria-hidden className="size-4.5 text-v5-border-strong" /><span className="sr-only">Not included</span></>
                              : v === null ? <><span aria-hidden>–</span><span className="sr-only">No trial</span></>
                              : v}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </PlanComparison>
      </Container>
    </section>
  );
}
