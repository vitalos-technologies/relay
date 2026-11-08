// Final invitation (server). No "join thousands" style claims.
import { ArrowRight } from 'lucide-react';
import { ButtonLink } from '@/components/ui-v5/button';
import { Accent, Container } from './section';
import { TRIAL_DAYS, TRIAL_REQUIRES_CARD } from './plan-data';

export function FinalCta({ signedIn }: { signedIn: boolean }) {
  return (
    <section aria-labelledby="cta-title" className="pb-20 sm:pb-28">
      <Container>
        <div className="relative overflow-hidden rounded-[28px] border border-v5-border bg-gradient-to-br from-[var(--mkt-lavender)] to-[var(--mkt-blob-b)]/40 px-6 py-14 text-center sm:px-12 sm:py-20">
          <div aria-hidden className="mkt-blob -left-24 -top-24 size-72 bg-[var(--mkt-blob-a)]" />
          <div aria-hidden className="mkt-blob -bottom-28 -right-16 size-72 bg-[var(--mkt-blob-b)]" />
          <div className="relative mx-auto flex max-w-xl flex-col items-center gap-5">
            <h2 id="cta-title" className="text-balance text-[30px] font-extrabold leading-[1.1] tracking-[-0.03em] text-v5-fg sm:text-[40px]"><Accent text="Bring your team *together*" /></h2>
            <p className="text-[17px] text-v5-muted">Start a {TRIAL_DAYS}-day free trial{TRIAL_REQUIRES_CARD ? '' : ' — no card needed'}.</p>
            {signedIn
              ? <ButtonLink href="/overview" size="lg">Open dashboard<ArrowRight aria-hidden /></ButtonLink>
              : <ButtonLink href="/signup" size="lg" data-testid="mkt-final-trial">Start free trial<ArrowRight aria-hidden /></ButtonLink>}
          </div>
        </div>
      </Container>
    </section>
  );
}
