// V5 MKT — the marketing page's data layer stays tied to the implementation: catalogue-derived pricing and comparison,
// honest integration statuses, FAQ answers that quote the catalogue, no fabricated claims, and the route constants.
import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '@social-lite/core';
import { CONNECTOR_KEYS } from '@social-lite/core/contracts/v35-connectors';
import { ALLOWANCES, FEATURES, PLANS, PUBLIC_PLAN_IDS, TRIAL_DAYS } from '@social-lite/core/contracts/v4-plans';
import { APP_HOME, MARKETING_SECTIONS, DEFAULT_MARKETING_CONFIG } from '@social-lite/core/contracts/v5-marketing';
import { comparison, describeAllowance, freePlan, paidPlans, pricingPlans, recurringTotalMinor } from '../../apps/web/components/marketing/plan-data';
import { cheapestPlanWithFeature, cheapestPlanWithMore, featureUpgradeMessage, limitUpgradeMessage, planPrice } from '@social-lite/core/contracts/plan-copy';
import { networks, STATUS_LABEL, TOOLS } from '../../apps/web/components/marketing/integrations-data';
import { CAPABILITIES, faq } from '../../apps/web/components/marketing/content';

const allCopy = () => JSON.stringify({ faq: faq(), caps: CAPABILITIES, nets: networks(), tools: TOOLS, cmp: comparison(), plans: pricingPlans() });

describe('routes and sections', () => {
  it('app home is /overview; sections are Product · AI · Integrations · Pricing · FAQ in order', () => {
    expect(APP_HOME).toBe('/overview');
    expect(MARKETING_SECTIONS.map((s) => s.label)).toEqual(['Product', 'AI', 'Integrations', 'Pricing', 'FAQ']);
    expect(DEFAULT_MARKETING_CONFIG).toMatchObject({ widget_enabled: false, widget_staffed: false });
  });
});

describe('pricing presentation (§18.5)', () => {
  it('the three public plans (D33), prices and examples from the catalogue', () => {
    const plans = pricingPlans();
    expect(plans.map((p) => p.id)).toEqual([...PUBLIC_PLAN_IDS]);
    expect(plans.map((p) => p.id)).toEqual(['free', 'standard', 'professional']);
    expect(plans.map((p) => p.price)).toEqual(['£0', '£5', '£15']);
    expect(plans.map((p) => p.free)).toEqual([true, false, false]);
    expect(freePlan()!.trial_days).toBe(0);
    expect(freePlan()!.examples).toEqual([{ seats: 1, total: '£0' }]); // Free: one user, no seat estimate
    expect(paidPlans().map((p) => p.trial_days)).toEqual([TRIAL_DAYS, TRIAL_DAYS]);
    expect(plans.find((p) => p.id === 'standard')!.examples.find((e) => e.seats === 3)!.total).toBe('£15');
    expect(plans.find((p) => p.id === 'professional')!.examples.find((e) => e.seats === 3)!.total).toBe('£45');
    expect(recurringTotalMinor('standard', 3)).toBe(1500);
    expect(() => recurringTotalMinor('standard', 0)).toThrow();
    expect(plans.some((p) => (p.id as string) === 'legacy')).toBe(false);
  });

  it('comparison rows are generated from catalogue features and allowances (no hand-written plan facts)', () => {
    const [features, allowances, trial] = comparison();
    expect(features!.rows.map((r) => r.key)).toEqual([...FEATURES]);
    for (const r of features!.rows) for (const id of PUBLIC_PLAN_IDS) {
      if (r.key === 'support' && id === 'free') { expect(r.values[id]).toBe('Help Centre'); continue; } // D33
      expect(r.values[id]).toBe(PLANS[id].features.includes(r.key as never));
    }
    expect(allowances!.rows.length).toBe(ALLOWANCES.length - 1); // X reads + writes share one row
    expect(new Set(allowances!.rows.map((r) => r.key))).toEqual(new Set(ALLOWANCES.filter((a) => a !== 'x_reads')));
    expect(allowances!.rows.find((r) => r.key === 'ai_tokens')!.values).toEqual({ free: '20k', standard: '100k + 50k per user', professional: '500k + 200k per user' });
    expect(allowances!.rows.find((r) => r.key === 'mcp_calls')!.values.standard).toBe('Not included');
    expect(trial!.rows.find((r) => r.key === 'trial_storage_bytes')!.values.standard).toBe('2 GB for the trial');
    expect(trial!.title).toContain(String(TRIAL_DAYS));
    expect(describeAllowance('x_writes', null)).toMatch(/Workspace budget/);
  });

  it('Free limits are shown honestly (D33): 1 user, 1 brand, 2 accounts, 10 posts, 500 MB, small AI; no trial column values', () => {
    const [features, allowances, trial] = comparison();
    const free = (key: string) => allowances!.rows.find((r) => r.key === key)!.values.free;
    expect([free('members'), free('brands'), free('social_accounts'), free('scheduled_posts'), free('storage_bytes'), free('ai_tokens')]).toEqual(['1', '1', '2', '10', '500 MB', '20k']);
    expect(allowances!.rows.slice(0, 4).map((r) => r.key)).toEqual(['members', 'brands', 'social_accounts', 'scheduled_posts']);
    for (const k of ['exports', 'listening_searches', 'integration_jobs', 'mcp_calls']) expect(free(k)).toBe('Not included');
    for (const f of ['analytics_standard', 'collaboration', 'inbox', 'listening', 'automation', 'integrations_business', 'mcp']) expect(features!.rows.find((r) => r.key === f)!.values.free).toBe(false);
    for (const r of trial!.rows) expect(r.values.free).toBeNull();
    expect(allowances!.rows.find((r) => r.key === 'members')!.values.standard).toBe('Billed per user');
    expect(allowances!.note).toContain('Data export always works');
  });
});

describe('upgrade prompt copy names the right plan and catalogue price (D33)', () => {
  it('cheapest plan with a feature / with more of an allowance', () => {
    expect(cheapestPlanWithFeature('publishing')).toBe('free');
    expect(cheapestPlanWithFeature('analytics_standard')).toBe('standard');
    expect(cheapestPlanWithFeature('mcp')).toBe('professional');
    expect(cheapestPlanWithMore('scheduled_posts', 'free')).toBe('standard');
    expect(cheapestPlanWithMore('members', 'free')).toBe('standard');
    expect(cheapestPlanWithMore('listening_searches', 'standard')).toBe('professional');
    expect(cheapestPlanWithMore('social_accounts', 'professional')).toBeNull();
    expect(cheapestPlanWithMore('ai_tokens', 'legacy')).toBeNull();
  });
  it('messages', () => {
    expect(planPrice('standard')).toBe('£5 per user / month');
    expect(planPrice('free')).toBe('£0');
    expect(featureUpgradeMessage('Standard analytics', 'Free', 'standard')).toBe('Standard analytics isn’t included in Free. Upgrade to Standard (£5 per user / month).');
    expect(featureUpgradeMessage('MCP', 'Standard', 'professional')).toBe('MCP isn’t included in Standard. Upgrade to Professional (£15 per user / month).');
    expect(limitUpgradeMessage('10 scheduled posts a month', 'Free', 'standard')).toBe('Free includes 10 scheduled posts a month. Upgrade to Standard (£5 per user / month).');
  });
});

describe('integrations (honest statuses, implemented only)', () => {
  it('every implemented publishing network appears exactly once with a known status', () => {
    expect(networks().map((n) => n.provider)).toEqual([...PROVIDERS]);
    for (const n of networks()) expect(Object.keys(STATUS_LABEL)).toContain(n.status);
  });
  it('tools are implemented connectors (or content hub / MCP); networks needing review are not marked available', () => {
    for (const t of TOOLS) expect([...CONNECTOR_KEYS, 'google_drive', 'notion', 'mcp']).toContain(t.key);
    const avail = networks().filter((n) => n.status === 'available').map((n) => n.provider).sort();
    expect(avail).toEqual(['bluesky', 'telegram']); // own credentials, no provider review
    for (const p of ['instagram', 'facebook', 'threads', 'x', 'youtube', 'linkedin', 'tiktok', 'pinterest']) expect(networks().find((n) => n.provider === p)!.status).not.toBe('available');
  });
});

describe('FAQ matches the implementation; no fabricated claims (§18.4)', () => {
  it('covers the required topics (incl. Free, D33)', () => {
    expect(faq().map((f) => f.id)).toEqual(['trial', 'free', 'per-user', 'channels', 'teammates', 'cancel', 'limits']);
  });
  it('quotes catalogue values', () => {
    const text = faq().map((f) => f.a.join(' ')).join(' ');
    expect(text).toContain(`${TRIAL_DAYS}-day free trial`);
    expect(text).toContain('no card needed');
    expect(text).toContain('£0');
    expect(text).toContain('£5');
    expect(text).toContain('£15');
    expect(text).toContain('£45');
    expect(text).toContain('first charge is on the day the trial ends');
    // D33: a trial or cancellation ends on Free; nothing is deleted; export always works; Free's limits are quoted.
    expect(faq().find((f) => f.id === 'trial')!.a.join(' ')).toMatch(/moves to Free.*Nothing is deleted and data export always works/);
    expect(faq().find((f) => f.id === 'cancel')!.a.join(' ')).toContain('moves to Free');
    expect(faq().find((f) => f.id === 'free')!.a.join(' ')).toContain('1 brand, 2 social accounts, 10 scheduled posts a month, 500 MB of media and 20k AI tokens a month');
    expect(text).not.toMatch(/£10|£25|£30|£75/);
    expect(text).toContain('up to 5 review-only guests');
  });
  it('no endorsements, invented statistics, ratings, unlimited claims or third tier', () => {
    const copy = allCopy();
    for (const bad of [/trusted by/i, /testimonial/i, /\b\d(\.\d)?\s*\/\s*5\b/, /\b\d+[kKmM]\+/, /join thousands/i, /most popular/i, /enterprise/i, /business plan/i, /annual/i, /\$\d/]) {
      expect(copy, String(bad)).not.toMatch(bad);
    }
    expect(copy.replace(/nothing is unlimited/gi, '')).not.toMatch(/unlimited/i);
  });
});
