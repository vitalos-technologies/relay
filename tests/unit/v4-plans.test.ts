import { describe, expect, it } from 'vitest';
import {
  CURRENCY, PLANS, PUBLIC_PLAN_IDS, TRIAL_DAYS, TRIAL_REQUIRES_CARD, allowanceFor, formatMinorGBP, publicCatalogue, recurringTotalMinor,
} from '@social-lite/core/contracts/v4-plans';

describe('V4/V5 plan catalogue', () => {
  it('has exactly two public plans: Standard £10 and Professional £25 per user per month, GBP, 14-day trial, no card', () => {
    const cat = publicCatalogue();
    expect(cat.map((p) => [p.id, p.name, p.unit_amount_minor, p.currency, p.interval, p.trial_days])).toEqual([
      ['standard', 'Standard', 1000, 'GBP', 'month', 14],
      ['professional', 'Professional', 2500, 'GBP', 'month', 14],
    ]);
    expect(PUBLIC_PLAN_IDS).toHaveLength(2);
    expect(CURRENCY).toBe('GBP');
    expect(TRIAL_DAYS).toBe(14);
    expect(TRIAL_REQUIRES_CARD).toBe(false);
    expect(PLANS.legacy.public).toBe(false);
  });

  it('prices per billable seat (brief examples) and requires at least one paid seat', () => {
    expect(formatMinorGBP(recurringTotalMinor('standard', 3))).toBe('£30');
    expect(formatMinorGBP(recurringTotalMinor('professional', 3))).toBe('£75');
    expect(() => recurringTotalMinor('standard', 0)).toThrow(/at least one/);
    expect(() => recurringTotalMinor('legacy', 1)).toThrow(/no price/);
  });

  it('Professional includes every Standard feature; trials are bounded (never unlimited)', () => {
    for (const f of PLANS.standard.features) expect(PLANS.professional.features).toContain(f);
    for (const id of PUBLIC_PLAN_IDS) {
      for (const [k, rule] of Object.entries(PLANS[id].trial_allowances)) expect(rule, `${id}.${k}`).not.toBeNull();
    }
    expect(allowanceFor(PLANS.professional.allowances, 'ai_tokens', 3)).toBe(500_000 + 3 * 200_000);
  });
});
