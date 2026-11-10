// `/` — Relay's public one-page marketing site (V5 §3–4, D23). Server-rendered. Section order per brief §4: header, hero,
// capability strip, product demonstrations (incl. #ai), integrations, pricing, FAQ, final invitation, footer.
// Signed-in visitors are NOT redirected; they see "Open dashboard". The page never loads the app shell or providers; its
// client JavaScript is limited to small islands (mobile menu, demo previews, seat estimate, comparison, FAQ, reveal).
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { DEFAULT_MARKETING_CONFIG, type MarketingConfig } from '@social-lite/core/contracts/v5-marketing';
import { SESSION_COOKIE, log, resolveSession } from '@social-lite/services';
import { marketingConfig } from '@social-lite/services/marketing/config';
import { SiteHeader } from '@/components/marketing/site-header';
import { Hero } from '@/components/marketing/hero';
import { CapabilityStrip } from '@/components/marketing/capability-strip';
import { ProductDemos } from '@/components/marketing/product-demos';
import { IntegrationsSection } from '@/components/marketing/integrations-section';
import { PricingSection } from '@/components/marketing/pricing-section';
import { TRIAL_DAYS, freePlan, paidPlans } from '@/components/marketing/plan-data';
import { FaqSection } from '@/components/marketing/faq-section';
import { FinalCta } from '@/components/marketing/final-cta';
import { SiteFooter } from '@/components/marketing/site-footer';
import { SupportWidgetMount } from '@/components/support-widget/mount'; // V5 WID: single widget mount point

const paid = paidPlans();
export const metadata: Metadata = {
  title: { absolute: 'Relay — Your social world. Working together.' },
  description: `Plan content, manage conversations, and get work done with AI. ${freePlan()?.name ?? 'Free'} for one person; ${paid.map((p) => `${p.name} ${p.price}`).join(' and ')} per user / month, with a ${TRIAL_DAYS}-day free trial.`,
};

async function signedIn(): Promise<boolean> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return false;
  try {
    return !!(await resolveSession(token));
  } catch (err) {
    log.warn('marketing_session_check_failed', { err: err as Error });
    return false;
  }
}

async function config(): Promise<MarketingConfig> {
  try {
    return await marketingConfig();
  } catch (err) {
    log.warn('marketing_config_unavailable', { err: err as Error });
    return { ...DEFAULT_MARKETING_CONFIG };
  }
}

export default async function MarketingPage() {
  const [authed, cfg] = await Promise.all([signedIn(), config()]);
  return (
    <>
      <SiteHeader signedIn={authed} />
      <main id="main" tabIndex={-1} className="outline-none">
        <Hero signedIn={authed} />
        <CapabilityStrip />
        <ProductDemos />
        <IntegrationsSection />
        <PricingSection />
        <FaqSection />
        <FinalCta signedIn={authed} />
      </main>
      <SiteFooter signedIn={authed} config={cfg} />
      <SupportWidgetMount config={cfg} />
    </>
  );
}
