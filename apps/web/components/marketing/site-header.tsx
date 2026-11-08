// Marketing header (server): Relay mark, section anchors (same page), Log in / Start free trial, or Open dashboard when a
// valid session exists (no redirect — D23). Sticky; the mobile menu is the only client island here.
import { MARKETING_SECTIONS } from '@social-lite/core/contracts/v5-marketing';
import { BRAND } from '@social-lite/core';
import { RelayWordmark } from '@/components/brand/relay-mark';
import { ButtonLink } from '@/components/ui-v5/button';
import { ArrowRight } from 'lucide-react';
import { Container } from './section';
import { MobileMenu } from './mobile-menu';

export function SiteHeader({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b bg-v5-bg/85 backdrop-blur-md supports-[backdrop-filter]:bg-v5-bg/75 border-b-v5-border/60">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-full focus:bg-v5-primary focus:px-4 focus:py-2 focus:text-v5-on-primary">Skip to content</a>
      <Container className="flex h-16 items-center gap-4">
        <a href="#top" className="inline-flex shrink-0 items-center rounded-md text-v5-fg outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-v5-ring" aria-label={`${BRAND.name} — back to top`}>
          <RelayWordmark size={26} />
        </a>
        <nav aria-label="Sections" className="ml-6 hidden lg:block">
          <ul className="flex items-center gap-1">
            {MARKETING_SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="inline-flex h-10 items-center rounded-full px-3.5 text-[14px] font-medium text-v5-muted outline-none hover:bg-v5-raised hover:text-v5-fg focus-visible:outline-2 focus-visible:outline-v5-ring" data-testid={`mkt-nav-${s.id}`}>{s.label}</a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {signedIn ? (
            <ButtonLink href="/overview" size="sm" className="hidden sm:inline-flex" data-testid="mkt-open-dashboard">Open dashboard<ArrowRight aria-hidden /></ButtonLink>
          ) : (
            <>
              <a href="/login" className="hidden h-10 items-center rounded-full px-3.5 text-[14px] font-semibold text-v5-fg outline-none hover:bg-v5-raised focus-visible:outline-2 focus-visible:outline-v5-ring sm:inline-flex" data-testid="mkt-login">Log in</a>
              <ButtonLink href="/signup" size="sm" className="hidden sm:inline-flex" data-testid="mkt-header-trial">Start free trial</ButtonLink>
            </>
          )}
          <MobileMenu signedIn={signedIn} />
        </div>
      </Container>
    </header>
  );
}
