// /signup?plan=standard|professional — selected-plan handoff from the marketing page (V5 §8). Public. Shows the chosen plan
// from the shared catalogue and starts the 14-day no-card trial flow (sign in / register → create workspace → trial).
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowRight, Check } from 'lucide-react';
import { publicCatalogue, TRIAL_DAYS, type PublicPlanId } from '@social-lite/core/contracts/v4-plans';
import { RelayWordmark } from '@/components/brand/relay-mark';
import { money } from '@/components/billing/format';

export const metadata: Metadata = { title: 'Start your free trial' };
export const dynamic = 'force-dynamic';

export default async function SignupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.plan) ? sp.plan[0] : sp.plan;
  const plans = publicCatalogue();
  const selected = (plans.find((p) => p.id === raw)?.id ?? 'standard') as PublicPlanId;
  return (
    <main className="flex min-h-dvh items-start justify-center px-4 py-10 sm:items-center">
      <div className="w-full max-w-[720px]">
        <div className="mb-8"><RelayWordmark size={30} /></div>
        <h1 className="text-[26px] font-semibold tracking-[-0.01em]">Start your {TRIAL_DAYS}-day free trial</h1>
        <p className="mt-1 text-sm text-muted">No card needed. Choose a plan when you’re ready.</p>
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2" role="list">
          {plans.map((p) => {
            const on = p.id === selected;
            return (
              <Link key={p.id} role="listitem" href={`/signup?plan=${p.id}`} aria-current={on ? 'true' : undefined} data-testid={`signup-plan-${p.id}`}
                className={`flex flex-col gap-2 rounded-2xl border p-5 ${on ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:bg-raised'}`}>
                <span className="flex items-center justify-between">
                  <span className="text-[17px] font-semibold">{p.name}</span>
                  {on ? <Check aria-label="Selected" className="size-5 text-accent-text" /> : null}
                </span>
                <span className="text-[13px] text-muted">{p.summary}</span>
                <span className="tabular"><span className="text-[22px] font-semibold">{money(p.unit_amount_minor)}</span> <span className="text-[13px] text-muted">per user / month after the trial</span></span>
                <ul className="mt-1 flex flex-col gap-1 text-[13px]">{p.highlights.slice(0, 4).map((h) => <li key={h}>· {h}</li>)}</ul>
              </Link>
            );
          })}
        </div>
        <Link href={`/signup/workspace?plan=${selected}`} data-testid="signup-continue"
          className="touch-target mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent text-[15px] font-medium text-on-accent hover:bg-accent-hover sm:w-auto sm:px-6">
          Start free trial on {plans.find((p) => p.id === selected)!.name}<ArrowRight aria-hidden className="size-4" />
        </Link>
        <p className="mt-3 text-xs text-muted">You’ll sign in or create an account, then name your workspace. Prices in GBP; any tax is shown at checkout.</p>
      </div>
    </main>
  );
}
