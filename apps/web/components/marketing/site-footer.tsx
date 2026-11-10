// Minimal footer (server): brand, section anchors, account actions, support, legal. Legal links come from Platform →
// Marketing; until they are configured they are shown as not published yet (never a dead link or an invented page).
import { MARKETING_SECTIONS, type MarketingConfig } from '@social-lite/core/contracts/v5-marketing';
import { BRAND } from '@social-lite/core';
import { RelayWordmark } from '@/components/brand/relay-mark';
import { Container } from './section';

const linkCls = 'inline-flex min-h-10 items-center rounded text-[14px] text-v5-muted outline-none hover:text-v5-fg focus-visible:outline-2 focus-visible:outline-v5-ring';

export function SiteFooter({ signedIn, config }: { signedIn: boolean; config: MarketingConfig }) {
  const legal: Array<{ label: string; href: string | null }> = [
    { label: 'Privacy', href: config.privacy_url },
    { label: 'Terms', href: config.terms_url },
  ];
  const external = (h: string) => /^https:/.test(h);
  return (
    <footer className="border-t border-v5-border pt-12 pb-28" data-testid="mkt-footer">
      <Container className="grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-[minmax(0,1.2fr)_repeat(3,minmax(0,1fr))]">
        <div className="col-span-2 flex flex-col gap-3 md:col-span-1">
          <RelayWordmark size={24} />
          <p className="max-w-xs text-[14px] text-v5-muted">Plan, publish, reply and learn together.</p>
        </div>
        <nav aria-label="Footer sections">
          <h2 className="text-[13px] font-bold text-v5-fg">Relay</h2>
          <ul className="mt-2">{MARKETING_SECTIONS.map((s) => <li key={s.id}><a href={`#${s.id}`} className={linkCls}>{s.label}</a></li>)}</ul>
        </nav>
        <nav aria-label="Account">
          <h2 className="text-[13px] font-bold text-v5-fg">Account</h2>
          <ul className="mt-2">
            {signedIn
              ? <li><a href="/overview" className={linkCls}>Open dashboard</a></li>
              : <><li><a href="/signup" className={linkCls}>Start free trial</a></li><li><a href="/login" className={linkCls}>Log in</a></li></>}
            {/* With the support widget on, #support opens it (WID launcher intercepts the link); otherwise in-app Help. */}
            <li><a href="/help" className={linkCls} data-testid="mkt-footer-help">Help Centre</a></li>
            <li><a href={config.widget_enabled ? '#support' : signedIn ? '/help/contact' : '/login?returnTo=%2Fhelp%2Fcontact'} className={linkCls} data-testid="mkt-footer-support">Support</a></li>
            {config.support_email ? <li><a href={`mailto:${config.support_email}`} className={linkCls}>{config.support_email}</a></li> : null}
          </ul>
        </nav>
        <nav aria-label="Legal">
          <h2 className="text-[13px] font-bold text-v5-fg">Legal</h2>
          <ul className="mt-2">
            {legal.map((l) => (
              <li key={l.label}>
                {l.href
                  ? <a href={l.href} className={linkCls} {...(external(l.href) ? { rel: 'noopener', target: '_blank' } : {})}>{l.label}</a>
                  : <span className="inline-flex min-h-10 items-center text-[14px] text-v5-muted" data-testid={`mkt-legal-${l.label.toLowerCase()}-pending`}>{l.label} <span className="ml-1.5 text-[12px]">(not published yet)</span></span>}
              </li>
            ))}
          </ul>
        </nav>
      </Container>
      <Container className="mt-10 flex flex-col gap-1 border-t border-v5-border pt-6 text-[13px] text-v5-muted sm:flex-row sm:gap-3">
        <span>© {new Date().getFullYear()} {BRAND.name}</span>
        <span aria-hidden="true" className="hidden sm:inline">·</span>
        <span data-testid="mkt-footer-maker">
          {BRAND.name} is a{' '}
          <a href="https://vitalos.co.uk/" rel="noopener" target="_blank" className="font-semibold text-v5-fg underline-offset-2 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-v5-ring">Vitalos Technologies</a>
          {' '}product
        </span>
      </Container>
    </footer>
  );
}
