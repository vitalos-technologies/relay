// Pricing (server shell): exactly the two public plans from the shared catalogue, "14 days free", no card, seat estimate,
// and the expandable feature/allowance comparison. Tax wording matches the configured checkout (no tax claim, D21).
import { Check, Minus } from 'lucide-react';
import { Container, SectionHeading } from './section';
import { PricingCards } from './pricing-cards';
import { PlanComparison } from './plan-comparison';
import { TRIAL_DAYS, TRIAL_REQUIRES_CARD, comparison, pricingPlans } from './plan-data';

export function PricingSection() {
  const plans = pricingPlans();
  const groups = comparison();
  return (
    <section id="pricing" aria-labelledby="pricing-title" className="scroll-mt-20 py-20 sm:py-28">
      <Container className="flex flex-col gap-10">
        <SectionHeading id="pricing-title" eyebrow="Pricing" title="Simple, per-user *pricing*" lead={`Two plans, billed monthly. Try either free for ${TRIAL_DAYS} days${TRIAL_REQUIRES_CARD ? '' : ' — no card needed'}.`} />
        <PricingCards plans={plans.map((p) => ({ id: p.id, name: p.name, summary: p.summary, price: p.price, highlights: p.highlights }))} trialDays={TRIAL_DAYS} noCard={!TRIAL_REQUIRES_CARD} />
        <p className="text-center text-[13px] text-v5-muted">Prices in GBP per active user, billed monthly. Any tax is shown at checkout. Pending invitations and review-only guests aren’t billed.</p>
        <PlanComparison>
          <div className="relative overflow-x-auto rounded-2xl border border-v5-border bg-v5-surface" data-testid="mkt-comparison">
            <table className="w-full min-w-[520px] border-collapse text-left text-[14px]">
              <caption className="sr-only">Plan comparison: features and allowances</caption>
              <thead>
                <tr className="border-b border-v5-border">
                  <th scope="col" className="p-4 font-semibold text-v5-muted">What’s included</th>
                  {plans.map((p) => <th key={p.id} scope="col" className="w-[30%] p-4 font-bold text-v5-fg">{p.name} <span className="font-normal text-v5-muted">{p.price}</span></th>)}
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
