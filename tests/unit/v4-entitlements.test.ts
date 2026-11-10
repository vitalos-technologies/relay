// V4 entitlements — pure derivation (billing state + overrides ⇒ features, allowances, access, period).
import { describe, expect, it } from 'vitest';
import type { BillingState } from '@social-lite/core/contracts/v4-billing';
import { ALLOWANCES, FEATURES, PLANS } from '@social-lite/core/contracts/v4-plans';
import { ALLOWANCE_METER, FEATURE_LABEL } from '@social-lite/core/contracts/v4-entitlements';
import { checkFeature, deriveEntitlements, meterRules, periodOf, upgradeTarget, type OverrideRow } from '@social-lite/services/entitlements/resolve';
import { workspaceCap } from '@social-lite/services/product/budgets';
import { routeFeature } from '@social-lite/services/entitlements/routes';
import { postMonth } from '@social-lite/services/entitlements/actions';

const NOW = new Date('2026-11-08T12:00:00Z');
const base = (p: Partial<BillingState> = {}): BillingState => ({
  workspace_id: 'w', plan_id: 'standard', plan_version_id: 'v1', status: 'active', seats: 2, trial: null,
  current_period: { start: '2026-11-03T00:00:00Z', end: '2026-12-03T00:00:00Z' }, cancel_at: null, scheduled_change: null, grace_ends_at: null,
  service_suspended: false, access: 'full', access_reason: null, as_of: NOW.toISOString(), ...p,
});
const ov = (o: Partial<OverrideRow>): OverrideRow => ({ id: 'o', workspace_id: 'w', kind: 'feature', key: 'listening', value: { enabled: true }, reason: 'reason text', expires_at: null,
  created_by: null, created_at: NOW, revoked_at: null, revoked_by: null, revoked_reason: null, ...o });

describe('derivation', () => {
  it('legacy: Professional features, unmetered, calendar month (pre-V4 behaviour)', () => {
    const c = deriveEntitlements(base({ plan_id: 'legacy', status: 'legacy', current_period: null }), [], NOW);
    expect(c.features.mcp.enabled).toBe(true);
    expect(ALLOWANCES.every((a) => c.limits[a].limit === null)).toBe(true);
    expect(c.period).toMatchObject({ key: '2026-11', kind: 'calendar_month', resets_at: '2026-12-01T00:00:00.000Z' });
  });

  it('allowances scale with seats; Standard lacks Professional features; upgrade target named', () => {
    const c = deriveEntitlements(base(), [], NOW);
    expect(c.limits.ai_tokens.limit).toBe(100_000 + 2 * 50_000);
    expect(c.limits.x_writes.limit).toBeNull();
    expect(checkFeature(c, 'listening', { paid: false })).toMatchObject({ ok: false, reason: 'feature_not_in_plan', details: { upgrade_to: 'professional' } });
    expect(upgradeTarget('publishing')).toBe('standard');
    expect(c.period).toMatchObject({ key: 'p:2026-11-03', kind: 'subscription', resets_at: '2026-12-03T00:00:00Z' });
  });

  it('trial: bounded trial allowances in one bucket that never resets; expiry ends the trial bucket', () => {
    const t = base({ status: 'trialing', plan_id: 'professional', current_period: null, trial: { started_at: '2026-11-01T09:00:00Z', ends_at: '2026-11-15T09:00:00Z', plan_id: 'professional' } });
    const c = deriveEntitlements(t, [], NOW);
    expect(c.trialActive).toBe(true);
    expect(c.limits.mcp_calls).toEqual({ limit: 500, included: 500, source: 'trial' });
    expect(periodOf(t, NOW)).toMatchObject({ key: 'trial:2026-11-01', resets_at: null });
    expect(deriveEntitlements(t, [], new Date('2026-11-16T00:00:00Z')).trialActive).toBe(false);
  });

  it('restricted: paid actions refused, reads allowed, support always; suspension wins over an access override', () => {
    const r = deriveEntitlements(base({ status: 'past_due', access: 'restricted', access_reason: 'A payment failed.' }), [], NOW);
    expect(checkFeature(r, 'publishing', { paid: true })).toMatchObject({ ok: false, reason: 'access_restricted' });
    expect(checkFeature(r, 'publishing', { paid: false })).toEqual({ ok: true });
    expect(checkFeature(r, 'support', { paid: true })).toEqual({ ok: true });
    const lifted = deriveEntitlements(base({ access: 'restricted' }), [ov({ kind: 'access', key: 'full', value: { level: 'full' }, expires_at: new Date(NOW.getTime() + 86_400_000) })], NOW);
    expect(lifted).toMatchObject({ access: 'full', accessOverridden: true });
    const susp = deriveEntitlements(base({ service_suspended: true, access: 'suspended' }), [ov({ kind: 'access', key: 'full', value: { level: 'full' } })], NOW);
    expect(susp.access).toBe('suspended');
  });

  it('overrides: expired/revoked ignored; a feature override brings a usable default allowance; an allowance override wins', () => {
    const past = new Date(NOW.getTime() - 1000);
    expect(deriveEntitlements(base(), [ov({ expires_at: past })], NOW).features.listening.enabled).toBe(false);
    expect(deriveEntitlements(base(), [ov({ revoked_at: past })], NOW).features.listening.enabled).toBe(false);
    const on = deriveEntitlements(base(), [ov({})], NOW);
    expect(on.features.listening).toEqual({ enabled: true, source: 'override' });
    expect(on.limits.listening_searches.limit).toBe(PLANS.professional.allowances.listening_searches!.base + 2 * PLANS.professional.allowances.listening_searches!.per_seat);
    const capped = deriveEntitlements(base(), [ov({}), ov({ id: 'o2', kind: 'allowance', key: 'listening_searches', value: { limit: 1 } })], NOW);
    expect(capped.limits.listening_searches).toEqual({ limit: 1, included: 1, source: 'override' });
  });

  it('meter rules: exports and X reads are never gated by access; plan ceiling under the customer cap', () => {
    const r = deriveEntitlements(base({ access: 'restricted' }), [], NOW);
    expect(meterRules(r, 'exports.count', 'month')).toMatchObject({ gate: { ok: true }, ceiling: 20, period: 'p:2026-11-03' });
    expect(meterRules(r, 'x.read', 'month').gate).toEqual({ ok: true });
    expect(meterRules(r, 'ai.tokens', 'month').gate).toMatchObject({ ok: false, reason: 'access_restricted' });
    expect(meterRules(r, 'storage.bytes', 'total').period).toBe('total');
    expect(workspaceCap({ monthly_exports: 1000 }, 'exports.count', 20)).toBe(20);
    expect(workspaceCap({ monthly_exports: 5 }, 'exports.count', 20)).toBe(5);
    expect(workspaceCap({}, 'ai.tokens', null)).toBe(200_000); // legacy safety default kept
    expect(workspaceCap({}, 'ai.tokens', 500_000)).toBe(500_000); // plan is the limit
  });

  it('every allowance maps to a meter or a gauge; every feature has a label', () => {
    expect(Object.keys(ALLOWANCE_METER).sort()).toEqual([...ALLOWANCES].sort());
    expect(Object.keys(FEATURE_LABEL).sort()).toEqual([...FEATURES].sort());
  });

  it('no plan (unknown id) ⇒ restricted, nothing granted', () => {
    const c = deriveEntitlements(base({ plan_id: null, status: 'none' }), [], NOW);
    expect(c.access).toBe('restricted');
    expect(checkFeature(c, 'publishing', { paid: false })).toMatchObject({ ok: false, reason: 'no_plan' });
  });

  it('D33 Free: Free limits and features; upgrade prompts name Standard with its price; calendar-month period', () => {
    const f = deriveEntitlements(base({ plan_id: 'free', status: 'free', seats: 0, current_period: null }), [], NOW);
    expect(f.access).toBe('full');
    expect([f.limits.members.limit, f.limits.brands.limit, f.limits.social_accounts.limit, f.limits.scheduled_posts.limit, f.limits.ai_tokens.limit, f.limits.exports.limit])
      .toEqual([1, 1, 2, 10, 20_000, 0]);
    expect(f.limits.storage_bytes.limit).toBe(500 * 1024 ** 2);
    expect(checkFeature(f, 'publishing', { paid: true })).toEqual({ ok: true });
    expect(checkFeature(f, 'analytics_standard', { paid: false })).toMatchObject({ ok: false, reason: 'feature_not_in_plan', details: { upgrade_to: 'standard' },
      message: 'Standard analytics isn’t included in Free. Upgrade to Standard (£5 per user / month).' });
    expect(checkFeature(f, 'mcp', { paid: false })).toMatchObject({ details: { upgrade_to: 'professional' } });
    expect(f.period).toMatchObject({ key: '2026-11', kind: 'calendar_month' });
    expect(meterRules(f, 'posts.scheduled', 'month')).toMatchObject({ ceiling: 10, gate: { ok: true } });
    // paid plans never meter posts / brands / members
    const std = deriveEntitlements(base(), [], NOW);
    expect([std.limits.scheduled_posts.limit, std.limits.brands.limit, std.limits.members.limit]).toEqual([null, null, null]);
  });

  it('D33 route gate: analytics and inbox API areas map to their features; everything else is ungated; posts count by month of publication', () => {
    expect(routeFeature('/api/analytics')).toBe('analytics_standard');
    expect(routeFeature('/api/analytics/exports/abc/download')).toBe('analytics_standard');
    expect(routeFeature('/api/inbox/conversations')).toBe('inbox');
    expect(routeFeature('/api/analyticsx')).toBeNull();
    expect(routeFeature('/api/posts')).toBeNull();
    expect(routeFeature('/api/brands/1/handover-export')).toBeNull(); // the data export is never gated
    expect(postMonth(new Date('2026-11-30T23:59:59Z'))).toBe('2026-11');
    expect(postMonth(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12');
  });
});
