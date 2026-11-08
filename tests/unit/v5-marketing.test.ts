// V5 MKT — the marketing page's data layer stays tied to the implementation: catalogue-derived pricing and comparison,
// honest integration statuses, FAQ answers that quote the catalogue, no fabricated claims, and the route constants.
import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '@social-lite/core';
import { CONNECTOR_KEYS } from '@social-lite/core/contracts/v35-connectors';
import { ALLOWANCES, FEATURES, PLANS, PUBLIC_PLAN_IDS, TRIAL_DAYS } from '@social-lite/core/contracts/v4-plans';
import { APP_HOME, MARKETING_SECTIONS, DEFAULT_MARKETING_CONFIG } from '@social-lite/core/contracts/v5-marketing';
import { comparison, describeAllowance, pricingPlans, recurringTotalMinor } from '../../apps/web/components/marketing/plan-data';
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
  it('exactly the two purchasable plans, prices and examples from the catalogue', () => {
    const plans = pricingPlans();
    expect(plans.map((p) => p.id)).toEqual([...PUBLIC_PLAN_IDS]);
    expect(plans.map((p) => p.price)).toEqual(['£10', '£25']);
    expect(plans.find((p) => p.id === 'standard')!.examples.find((e) => e.seats === 3)!.total).toBe('£30');
    expect(plans.find((p) => p.id === 'professional')!.examples.find((e) => e.seats === 3)!.total).toBe('£75');
    expect(recurringTotalMinor('standard', 3)).toBe(3000);
    expect(() => recurringTotalMinor('standard', 0)).toThrow();
    expect(plans.some((p) => (p.id as string) === 'legacy')).toBe(false);
  });

  it('comparison rows are generated from catalogue features and allowances (no hand-written plan facts)', () => {
    const [features, allowances, trial] = comparison();
    expect(features!.rows.map((r) => r.key)).toEqual([...FEATURES]);
    for (const r of features!.rows) for (const id of PUBLIC_PLAN_IDS) expect(r.values[id]).toBe(PLANS[id].features.includes(r.key as never));
    expect(allowances!.rows.length).toBe(ALLOWANCES.length - 1); // X reads + writes share one row
    expect(allowances!.rows.find((r) => r.key === 'ai_tokens')!.values).toEqual({ standard: '100k + 50k per user', professional: '500k + 200k per user' });
    expect(allowances!.rows.find((r) => r.key === 'mcp_calls')!.values.standard).toBe('Not included');
    expect(trial!.rows.find((r) => r.key === 'trial_storage_bytes')!.values.standard).toBe('2 GB for the trial');
    expect(trial!.title).toContain(String(TRIAL_DAYS));
    expect(describeAllowance('x_writes', null)).toMatch(/Workspace budget/);
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
  it('covers the six required topics', () => {
    expect(faq().map((f) => f.id)).toEqual(['trial', 'per-user', 'channels', 'teammates', 'cancel', 'limits']);
  });
  it('quotes catalogue values', () => {
    const text = faq().map((f) => f.a.join(' ')).join(' ');
    expect(text).toContain(`${TRIAL_DAYS}-day free trial`);
    expect(text).toContain('no card needed');
    expect(text).toContain('£10');
    expect(text).toContain('£25');
    expect(text).toContain('£30');
    expect(text).toContain('£75');
    expect(text).toContain('first charge is on the day the trial ends');
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
