// V2 stream D pure logic: health classification, duplicate similarity, activity categories, budget
// messages/caps and the export ZIP writer. No database.
import { describe, expect, it } from 'vitest';
import { classifyConnection, type ConnectionFacts } from '@social-lite/services/product/health';
import { normaliseForDuplicate, textSimilarity } from '@social-lite/services/product/duplicates';
import { categoryOf } from '@social-lite/services/product/activity';
import { exhaustedMessage, periodFor, workspaceCap } from '@social-lite/services/product/budgets';
import { unzip, zip } from '@social-lite/services/product/zip';

const now = new Date('2026-11-07T12:00:00Z');
const base: ConnectionFacts = {
  id: 'c', brand_id: 'b', provider: 'facebook', display_name: 'Page', status: 'ready', is_mock: false, paused: false, disconnected_at: null,
  throttled_until: null, health_detail: { message: 'ok' }, health_checked_at: now, cred_expires_at: null, refresh_expires_at: null, granted_scopes: [], circuit_open_until: null,
};
const codes = (c: Partial<ConnectionFacts>, o: Partial<Parameters<typeof classifyConnection>[1]> = {}) =>
  classifyConnection({ ...base, ...c }, { now, canManage: true, ...o }).map((i) => i.code);

describe('account health classification', () => {
  it('healthy connection has no issues', () => expect(codes({})).toEqual([]));
  it('disconnected short-circuits with a reconnect fix', () => {
    const [i] = classifyConnection({ ...base, disconnected_at: now, status: 'disconnected' }, { now, canManage: true });
    expect(i).toMatchObject({ code: 'disconnected', severity: 'critical', fix: { action: 'reconnect', allowed: true } });
  });
  it('expired vs revoked', () => {
    expect(codes({ status: 'reconnect_required', cred_expires_at: new Date('2026-11-01T00:00:00Z') })).toEqual(['expired']);
    expect(codes({ status: 'reconnect_required' })).toEqual(['revoked']);
  });
  it('missing scope names the scopes; Telegram asks for bot admin rights', () => {
    const [i] = classifyConnection({ ...base, status: 'missing_permission', health_detail: { missing_permissions: ['pages_manage_posts'] } }, { now, canManage: false });
    expect(i!.detail).toContain('pages_manage_posts');
    expect(i!.fix).toMatchObject({ allowed: false, who: 'An owner or admin' });
    expect(classifyConnection({ ...base, provider: 'telegram', status: 'missing_permission' }, { now, canManage: true })[0]!.fix.action).toBe('bot_admin');
  });
  it('expiring within 7 days without refresh; X short-lived tokens are not "expiring"', () => {
    const soon = new Date(now.getTime() + 3 * 86_400_000);
    const [i] = classifyConnection({ ...base, cred_expires_at: soon }, { now, canManage: true });
    expect(i).toMatchObject({ code: 'expiring', title: 'Expires in 3 days', at_risk_from: soon.toISOString() });
    expect(codes({ provider: 'x', cred_expires_at: new Date(now.getTime() + 3600_000) })).toEqual([]);
    expect(codes({ cred_expires_at: soon, refresh_expires_at: new Date(now.getTime() + 60 * 86_400_000) })).toEqual([]);
  });
  it('throttled, paused, provider outage, budget, stale', () => {
    expect(codes({ throttled_until: new Date(now.getTime() + 60_000) })).toEqual(['throttled']);
    expect(codes({ paused: true })).toEqual(['paused']);
    expect(codes({ circuit_open_until: new Date(now.getTime() + 60_000) })).toEqual(['provider_outage']);
    expect(codes({ provider: 'x' }, { xBudgetExhausted: true })).toEqual(['budget_exhausted']);
    expect(codes({ health_checked_at: new Date(now.getTime() - 3 * 86_400_000) })).toEqual(['stale_check']);
    expect(codes({ is_mock: true, health_checked_at: null })).toEqual([]);
  });
});

describe('duplicate similarity', () => {
  it('normalises case, punctuation and tracking parameters', () => {
    expect(normaliseForDuplicate('Hello, WORLD!! https://www.Example.com/a?utm_source=x')).toBe('hello world example.com/a');
  });
  it('near-identical ≥ 0.8, unrelated low, empty 0', () => {
    expect(textSimilarity('Our spring sale starts Monday', 'Our spring sale starts on Monday!')).toBeGreaterThan(0.8);
    expect(textSimilarity('Our spring sale starts Monday', 'Meet the team behind the product')).toBeLessThan(0.35);
    expect(textSimilarity('', 'x')).toBe(0);
  });
});

describe('activity categories', () => {
  it.each([
    ['member.removed', 'permissions'], ['grant.revoked', 'permissions'], ['connection.disconnected', 'connections'],
    ['schedule.created', 'publishing'], ['approval.approved', 'publishing'], ['session.revoked', 'security'],
    ['export.handover', 'security'], ['asset.uploaded', 'content'], ['inbox.assigned', 'care'], ['case.updated', 'care'], ['automation.rule_updated', 'care'], ['mcp.client_revoked', 'security'],
  ])('%s → %s', (a, c) => expect(categoryOf(a)).toBe(c));
});

describe('budgets', () => {
  it('caps come from workspaces.limits; AI has a default; storage is a running total', () => {
    expect(workspaceCap({}, 'ai.tokens')).toBe(200_000);
    expect(workspaceCap({ ai_monthly_tokens: 10 }, 'ai.tokens')).toBe(10);
    expect(workspaceCap({}, 'x.write')).toBeNull();
    expect(workspaceCap({ storage_bytes: -1 }, 'storage.bytes')).toBeNull();
    expect(periodFor('storage.bytes')).toBe('total');
    expect(periodFor('exports.count', now)).toBe('2026-11');
  });
  it('explains which scope is exhausted', () => {
    expect(exhaustedMessage({ meter: 'exports.count', scope: 'team', team_id: 't', team_name: 'Agency', cap: 2, used: 2, reserved: 0, needed: 1, period: '2026-11' })).toMatch(/Agency team’s monthly export budget \(2\)/);
    expect(exhaustedMessage({ meter: 'storage.bytes', scope: 'workspace', team_id: null, team_name: null, cap: 10 * 1_048_576, used: 9 * 1_048_576, reserved: 0, needed: 2 * 1_048_576, period: 'total' })).toMatch(/1 MB of 10 MB free/);
  });
});

describe('zip writer', () => {
  it('round-trips entries and refuses unsafe names', () => {
    const z = zip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.json', data: Buffer.from('{"x":1}') }]);
    const files = unzip(z);
    expect(files['a.txt']!.toString()).toBe('hello');
    expect(JSON.parse(files['dir/b.json']!.toString())).toEqual({ x: 1 });
    expect(z.subarray(z.length - 22).readUInt32LE(0)).toBe(0x06054b50);
    expect(() => zip([{ name: '../evil', data: 'x' }])).toThrow(/unsafe/);
  });
});
