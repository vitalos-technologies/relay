// Pricing (server shell): the three public plans from the shared catalogue (D33: Free £0, Standard and Professional per user
// with a 14-day no-card trial), seat estimate for paid plans, and the expandable feature/allowance comparison. Tax wording matches the configured checkout (no tax claim, D21).
import { Check, Minus } from 'lucide-react';
import { Container, SectionHeading } from './section';
import { PricingCards } from './pricing-cards';
import { PlanComparison } from './plan-comparison';
import { Reveal } from '@/components/ui-v5/reveal';
import { TRIAL_DAYS, TRIAL_REQUIRES_CARD, comparison, paidPlans, pricingPlans } from './plan-data';

export function PricingSection() {
  const plans = pricingPlans();
  const groups = comparison();
  const paid = paidPlans().map((p) => p.name).join(' or ');
  return (
    <section id="pricing" aria-labelledby="pricing-title" className="scroll-mt-20 py-20 sm:py-28">
      <Container className="flex flex-col gap-10">
        <Reveal><SectionHeading id="pricing-title" eyebrow="Pricing" title="Simple, per-user *pricing*" lead={`Start free, or try ${paid} free for ${TRIAL_DAYS} days${TRIAL_REQUIRES_CARD ? '' : ' — no card needed'}.`} /></Reveal>
        <PricingCards plans={plans.map((p) => ({ id: p.id, name: p.name, summary: p.summary, price: p.price, free: p.free, highlights: p.highlights }))} trialDays={TRIAL_DAYS} noCard={!TRIAL_REQUIRES_CARD} />
        <p className="mx-auto max-w-[760px] text-balance text-center text-[13px] text-v5-muted">Prices in GBP per active user, billed monthly. Any tax is shown at checkout. Pending invitations and review-only guests aren’t billed. A trial that ends without a subscription moves to Free — nothing is deleted.</p>
        <PlanComparison>
          <div className="relative overflow-x-auto rounded-2xl border border-v5-border bg-v5-surface" data-testid="mkt-comparison">
            <table className="w-full min-w-[640px] border-collapse text-left text-[14px]">
              <caption className="sr-only">Plan comparison: features and allowances</caption>
              <thead>
                <tr className="border-b border-v5-border">
                  <th scope="col" className="p-4 font-semibold text-v5-muted">What’s included</th>
                  {plans.map((p) => <th key={p.id} scope="col" className="w-[22%] p-4 font-bold text-v5-fg">{p.name} <span className="font-normal text-v5-muted">{p.price}</span></th>)}
                </tr>
              </thead>
              {groups.map((g) => (
                <tbody key={g.id}>
                  <tr className="bg-v5-raised">
                    <th scope="colgroup" colSpan={plans.length + 1} className="px-4 py-2.5 text-[13px] font-bold text-v5-fg">{g.title}{g.note ? <span className="ml-2 font-normal text-v5-muted">{g.note}</span> : null}</th>
                  </tr>
                  {g.rows.map((r) => (
                    <tr key={r.key} className="border-t border-v5-border">
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
