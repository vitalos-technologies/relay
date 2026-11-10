import { describe, expect, it } from 'vitest';
import {
  CURRENCY, PLANS, PUBLIC_PLAN_IDS, TRIAL_DAYS, TRIAL_REQUIRES_CARD, allowanceFor, formatMinorGBP, publicCatalogue, recurringTotalMinor,
} from '@social-lite/core/contracts/v4-plans';
import { PAID_PLAN_IDS } from '@social-lite/services/billing/catalogue';
import { planVersionDefinition } from '@social-lite/services/billing/catalogue-def';

describe('V4/V5 plan catalogue (D33)', () => {
  it('has exactly three public plans: Free £0, Standard £5 and Professional £15 per user per month, GBP; 14-day no-card trial on paid plans only', () => {
    const cat = publicCatalogue();
    expect(cat.map((p) => [p.id, p.name, p.unit_amount_minor, p.currency, p.interval, p.trial_days])).toEqual([
      ['free', 'Free', 0, 'GBP', 'month', 0],
      ['standard', 'Standard', 500, 'GBP', 'month', 14],
      ['professional', 'Professional', 1500, 'GBP', 'month', 14],
    ]);
    expect(PUBLIC_PLAN_IDS).toHaveLength(3);
    expect(PAID_PLAN_IDS).toEqual(['standard', 'professional']);
    expect(CURRENCY).toBe('GBP');
    expect(TRIAL_DAYS).toBe(14);
    expect(TRIAL_REQUIRES_CARD).toBe(false);
    expect(PLANS.legacy.public).toBe(false);
  });

  it('prices per billable seat (3 Standard = £15, 3 Professional = £45, Free = £0) and requires at least one seat', () => {
    expect(formatMinorGBP(recurringTotalMinor('standard', 3))).toBe('£15');
    expect(formatMinorGBP(recurringTotalMinor('professional', 3))).toBe('£45');
    expect(recurringTotalMinor('free', 1)).toBe(0);
    expect(formatMinorGBP(recurringTotalMinor('free', 1))).toBe('£0');
    expect(() => recurringTotalMinor('standard', 0)).toThrow(/at least one/);
    expect(() => recurringTotalMinor('legacy', 1)).toThrow(/no price/);
  });

  it('Free is public but never purchasable (no checkout, no provider price); paid plans are', () => {
    expect(planVersionDefinition('free')).toMatchObject({ unit_amount_minor: 0, purchasable: false, trial_days: 0 });
    expect(planVersionDefinition('standard').purchasable).toBe(true);
    expect(planVersionDefinition('professional').purchasable).toBe(true);
    expect(planVersionDefinition('legacy').purchasable).toBe(false);
  });

  it('Free limits (D33): 1 user, 1 brand, 2 accounts, 10 scheduled posts, 500 MB, 20k AI tokens; no analytics, collaboration, inbox, listening, automation, integrations, MCP', () => {
    const f = PLANS.free;
    const lim = (k: Parameters<typeof allowanceFor>[1]) => allowanceFor(f.allowances, k, 1);
    expect([lim('members'), lim('brands'), lim('social_accounts'), lim('scheduled_posts'), lim('storage_bytes'), lim('ai_tokens'), lim('exports')])
      .toEqual([1, 1, 2, 10, 500 * 1024 ** 2, 20_000, 0]);
    for (const x of ['analytics_standard', 'collaboration', 'inbox', 'listening', 'automation', 'integrations_business', 'mcp', 'approvals_advanced'] as const) expect(f.features).not.toContain(x);
    expect(f.features).toEqual(expect.arrayContaining(['publishing', 'media_library', 'support']));
  });

  it('Professional includes every Standard feature; trials bound every costly allowance (never unlimited)', () => {
    for (const f of PLANS.standard.features) expect(PLANS.professional.features).toContain(f);
    // scheduled_posts / brands / members are not metered on paid plans (members are bounded by paid seats).
    const unmeteredOnPaid = new Set(['scheduled_posts', 'brands', 'members']);
    for (const id of PUBLIC_PLAN_IDS) {
      for (const [k, rule] of Object.entries(PLANS[id].trial_allowances)) if (!unmeteredOnPaid.has(k)) expect(rule, `${id}.${k}`).not.toBeNull();
    }
    expect(allowanceFor(PLANS.professional.allowances, 'ai_tokens', 3)).toBe(500_000 + 3 * 200_000);
  });
});
