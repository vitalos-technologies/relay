// V5 marketing contract (brief docs/queue/03h_V5_PROMPT.md §3–4, §16; decisions D23–D24). Pure: no IO.
//  - APP_HOME: the signed-in app home moved from `/` to `/overview` (D23). Every "go home" inside the app and the default
//    post-login destination use this constant; `/` is the public marketing page.
//  - MarketingConfig: the small Platform → Marketing configuration (no secrets). Stored in `system_flags`
//    (key MARKETING_CONFIG_KEY), read through `marketingConfig()` in packages/services/src/marketing/config.ts (WID reads the
//    widget switches from there). There is deliberately no public settings API: the marketing page reads it server-side.

export const APP_HOME = '/overview' as const;

/** Section anchors of the one-page site, in page order (brief §4). Navigation scrolls; nothing here leaves the page. */
export const MARKETING_SECTIONS = [
  { id: 'product', label: 'Product' },
  { id: 'ai', label: 'AI' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'faq', label: 'FAQ' },
] as const;
export type MarketingSectionId = (typeof MARKETING_SECTIONS)[number]['id'];

export const MARKETING_CONFIG_KEY = 'marketing_config' as const;

export interface MarketingConfig {
  /** Show the support chat launcher on the marketing page (stream WID). */
  widget_enabled: boolean;
  /**
   * Staffed live-chat availability is established (people are actually watching Platform → Support). When false the widget
   * says "Send us a message" and never claims an online status or response time (brief §9).
   */
  widget_staffed: boolean;
  /** Show the support launcher inside the signed-in app too (WID decides whether it supports this). */
  widget_in_app: boolean;
  /** Legal destinations linked from the footer (same-site paths or https URLs). null = not published yet (shown as such). */
  privacy_url: string | null;
  terms_url: string | null;
  /** Public contact address shown in the footer "Support" entry when set (no secrets; validated email). */
  support_email: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

export const DEFAULT_MARKETING_CONFIG: MarketingConfig = {
  widget_enabled: false,
  widget_staffed: false,
  widget_in_app: false,
  privacy_url: null,
  terms_url: null,
  support_email: null,
  updated_at: null,
  updated_by: null,
};
