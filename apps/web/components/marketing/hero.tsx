// Hero (server): headline, supporting line, Start free trial + Explore Relay (scrolls to the product demonstrations — there
// is no genuine demo video, brief §3), price line from the catalogue, and an illustrative product preview
// (a real Overview capture of a synthetic showcase workspace, optimised, fixed dimensions). Content is synthetic and
// captioned as an illustrative preview.
import { getImageProps } from 'next/image';
import { ArrowDown, ArrowRight, Check, Sparkles } from 'lucide-react';
import { ButtonLink } from '@/components/ui-v5/button';
import { Container } from './section';
import { TRIAL_DAYS, TRIAL_REQUIRES_CARD, pricingPlans } from './plan-data';

export function Hero({ signedIn }: { signedIn: boolean }) {
  const plans = pricingPlans();
  return (
    <section id="top" aria-labelledby="hero-title" className="relative overflow-hidden">
      <div aria-hidden className="mkt-blob -right-40 top-10 size-[520px] bg-[var(--mkt-blob-a)]" />
      <div aria-hidden className="mkt-blob -left-56 -top-24 size-[380px] bg-[var(--mkt-blob-b)] opacity-60" />
      <Container className="relative grid items-center gap-12 pb-16 pt-12 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-10 lg:pb-24 lg:pt-20">
        <div className="flex flex-col items-start gap-6">
          <p className="mkt-rise inline-flex items-center gap-2 rounded-full border border-v5-border bg-v5-surface px-3 py-1 text-[13px] font-medium text-v5-muted">
            <span aria-hidden className="size-1.5 rounded-full bg-v5-primary-text" />
            {TRIAL_DAYS} days free{TRIAL_REQUIRES_CARD ? '' : ' · No card needed'}
          </p>
          <h1 id="hero-title" className="mkt-rise text-balance text-[40px] font-extrabold leading-[1.04] tracking-[-0.035em] text-v5-fg sm:text-[56px] lg:text-[64px]">
            Your social world. <span className="mkt-gradient-text">Working together.</span>
          </h1>
          <p className="mkt-rise-2 max-w-[34rem] text-pretty text-[18px] text-v5-muted sm:text-[19px]">Plan content, manage conversations, and get work done with AI.</p>
          <div className="mkt-rise-2 flex w-full flex-col gap-3 min-[420px]:w-auto min-[420px]:flex-row">
            {signedIn
              ? <ButtonLink href="/overview" size="lg" data-testid="mkt-hero-dashboard">Open dashboard<ArrowRight aria-hidden /></ButtonLink>
              : <ButtonLink href="/signup" size="lg" data-testid="mkt-hero-trial">Start free trial<ArrowRight aria-hidden /></ButtonLink>}
            <ButtonLink href="#product" variant="outline" size="lg" data-testid="mkt-hero-explore">Explore Relay<ArrowDown aria-hidden /></ButtonLink>
          </div>
          <p className="mkt-rise-2 text-[14px] text-v5-muted">
            {plans.map((p, i) => <span key={p.id}>{i ? ' · ' : ''}{p.name} {p.price}</span>)} per user / month after the trial
          </p>
        </div>
        <HeroPreview />
      </Container>
    </section>
  );
}

const ALT = 'Relay’s Overview dashboard for an example bakery brand: five posts scheduled this week across Instagram, Facebook, LinkedIn and Threads, two awaiting approval, no delivery issues and all accounts healthy.';

/**
 * Hero visual: a real capture of Relay's Overview (synthetic "Relay Showcase" workspace — scripts/seed-marketing-showcase.ts +
 * scripts/marketing-capture.mjs) in a window frame, with two small floating cards built as components. next/image serves
 * AVIF/WebP at the requested width; light/dark variants are chosen by the OS colour scheme through <picture> so only one
 * file downloads. Explicit width/height reserve the space (no layout shift); fetchPriority high because it is the LCP image.
 */
function HeroPreview() {
  const common = { alt: ALT, width: 2560, height: 1600, quality: 75, sizes: '(min-width: 1200px) 620px, (min-width: 1024px) 52vw, (min-width: 640px) 88vw, 100vw' };
  const { props: { srcSet: dark } } = getImageProps({ ...common, src: '/marketing/overview-dark.webp' });
  const { props: light } = getImageProps({ ...common, src: '/marketing/overview-light.webp', fetchPriority: 'high', loading: 'eager' });
  return (
    <figure className="mkt-rise-3 relative mx-auto w-full max-w-[640px] lg:max-w-none" aria-labelledby="hero-preview-caption">
      <div className="relative pb-7 pt-6 sm:pb-9 sm:pt-8">
        {/* window frame */}
        <div className="relative overflow-hidden rounded-[14px] border border-v5-border bg-v5-surface shadow-[var(--mkt-shadow)] sm:rounded-[18px]" data-testid="mkt-hero-shot">
          <div aria-hidden className="flex h-6 items-center gap-1.5 border-b border-v5-border bg-v5-raised px-3 sm:h-8">
            <span className="size-2 rounded-full bg-[#f87171] sm:size-2.5" /><span className="size-2 rounded-full bg-[#fbbf24] sm:size-2.5" /><span className="size-2 rounded-full bg-[#34d399] sm:size-2.5" />
          </div>
          <picture>
            <source media="(prefers-color-scheme: dark)" srcSet={dark} sizes={common.sizes} />
            <img {...light} alt={ALT} className="block h-auto w-full" />
          </picture>
        </div>
        {/* floating AI result (non-metric) */}
        <div aria-hidden className="absolute -right-3 top-0 z-10 hidden w-[208px] rounded-2xl border border-v5-border bg-v5-surface p-3 shadow-[var(--mkt-shadow)] sm:block lg:-right-8">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-v5-fg"><Sparkles className="size-3.5 text-v5-primary-text" />AI drafted 3 captions</p>
          <span className="mt-2 block h-1.5 w-[92%] rounded-full bg-v5-raised" />
          <span className="mt-1.5 block h-1.5 w-[78%] rounded-full bg-v5-raised" />
          <span className="mt-1.5 block h-1.5 w-[64%] rounded-full bg-v5-raised" />
          <p className="mt-2 text-[11px] font-medium text-v5-primary-text">Saved as drafts · ready for review</p>
        </div>
        {/* floating scheduled toast */}
        <div aria-hidden className="absolute bottom-0 left-2 z-10 flex items-center gap-2.5 rounded-2xl border border-v5-border bg-v5-surface py-2 pl-2 pr-3.5 shadow-[var(--mkt-shadow)] sm:-left-6 sm:py-2.5 sm:pl-2.5 sm:pr-4">
          <span className="inline-flex size-7 items-center justify-center rounded-full bg-v5-success-soft text-v5-success"><Check className="size-4" /></span>
          <span className="leading-tight"><span className="block text-[12px] font-semibold text-v5-fg">Scheduled</span><span className="text-[11px] text-v5-muted">Wed 11 · 09:30</span></span>
        </div>
      </div>
      <figcaption id="hero-preview-caption" className="mt-2 text-center text-[12px] text-v5-muted">Illustrative preview with example content.</figcaption>
    </figure>
  );
}
