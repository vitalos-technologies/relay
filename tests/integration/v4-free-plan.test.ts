// D33 Free plan limits, enforced server-side by the shared entitlement service with the REAL billing state (a workspace
// created through /signup?plan=free): 10 scheduled posts a month (once per post, idempotent, race-safe for the last
// unit), 1 brand, 2 social accounts, 1 user (no teammates), 500 MB media, 20k AI tokens, and the features Free lacks
// (analytics, inbox, approvals, listening, automation, integrations, MCP, report exports). The data export always works.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toLocalInput } from '@social-lite/core';
import { createPost, publishNow, schedulePost, submitForReview, getApprovalPolicy, saveApprovalPolicy } from '@social-lite/services';
import { createSession } from '@social-lite/services/auth/session';
import { signupWorkspace } from '@social-lite/services/billing/signup';
import { setBillingProviderForTests } from '@social-lite/services/billing/provider';
import { createBrand } from '@social-lite/services/brands';
import { connectMock } from '@social-lite/services/connections/index';
import { createInvitation } from '@social-lite/services/auth/invitations';
import { createUploadIntent } from '@social-lite/services/media/assets';
import { activityCsv, reserveUsage } from '@social-lite/services/product/index';
import { chargeMcpCall } from '@social-lite/services/entitlements/actions';
import { assertRouteEntitled } from '@social-lite/services/entitlements/routes';
import { workspaceEntitlements } from '@social-lite/services/entitlements/usage';
import { createSearch } from '@social-lite/services/listening/searches';
import { closeTestPool, createUser, testPool, v2Ctx } from './helpers.js';

beforeAll(() => { testPool(); setBillingProviderForTests(undefined); });
afterAll(closeTestPool);
const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await testPool().query(sql, p)).rows as T[];

async function freeTenant() {
  const u = await createUser();
  const { session } = await createSession(testPool(), u.id, {});
  const r = await signupWorkspace(session, { userId: u.id, email: u.email, name: 'Owner', sessionId: session.id }, { name: `Free ${randomUUID().slice(0, 6)}`, timezone: 'Europe/London', plan: 'free' });
  const ws = r.workspace.id;
  const ctx = await v2Ctx(u.id, ws);
  const a = await connectMock(ctx, r.brand.id, { provider: 'facebook', display_name: 'Page' });
  const b = await connectMock(ctx, r.brand.id, { provider: 'telegram', display_name: 'Channel' });
  return { ws, brandId: r.brand.id, owner: u, ctx, conns: [a.id, b.id] as [string, string] };
}

type T = Awaited<ReturnType<typeof freeTenant>>;
const draft = (connIds: string[]) => ({ draft: { baseText: 'Hello', baseLink: null, baseAssetIds: [], variants: connIds.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) } });
/** A post due `days` from now at 10:00 London. */
async function scheduleOne(t: T, connIds: string[], due: Date) {
  const { id } = await createPost(t.ctx, t.brandId, draft(connIds), randomUUID());
  await schedulePost(t.ctx, id, { expected_version: 1, connection_ids: connIds, input_local_time: toLocalInput(due, 'Europe/London'), timezone: 'Europe/London' }, randomUUID());
  return id;
}
const month = (d: Date) => d.toISOString().slice(0, 7);
const used = async (ws: string, period: string) => Number((await q<{ used: string }>(`SELECT used FROM usage_counters WHERE workspace_id=$1 AND team_id IS NULL AND meter='posts.scheduled' AND period=$2`, [ws, period]))[0]?.used ?? 0);

describe('Free limits (D33)', () => {
  it('10 scheduled posts a month: each post counts once (several destinations, re-scheduling); the 11th is refused; next month has its own 10', async () => {
    const t = await freeTenant();
    // a fixed point well inside a month so every post lands in the same calendar month
    const now = new Date();
    const due = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15, 9, 0, 0));
    const first = await scheduleOne(t, t.conns, due); // two destinations → one unit
    expect(await used(t.ws, month(due))).toBe(1);
    // re-scheduling the same post in the same month is free (idempotent)
    await schedulePost(t.ctx, first, { expected_version: 1, connection_ids: t.conns, input_local_time: toLocalInput(new Date(due.getTime() + 3600_000), 'Europe/London'), timezone: 'Europe/London' }, randomUUID());
    expect(await used(t.ws, month(due))).toBe(1);
    for (let i = 1; i < 10; i++) await scheduleOne(t, [t.conns[0]], new Date(due.getTime() + i * 60_000));
    expect(await used(t.ws, month(due))).toBe(10);
    await expect(scheduleOne(t, [t.conns[0]], new Date(due.getTime() + 11 * 60_000)))
      .rejects.toMatchObject({ code: 'entitlement_required', status: 402, details: { reason: 'allowance_exhausted', allowance: 'scheduled_posts', limit: 10, upgrade_to: 'standard' } });
    expect(await used(t.ws, month(due))).toBe(10); // the refused attempt left nothing behind
    // the following month is a separate allowance
    const nextMonth = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 15, 9, 0, 0));
    await scheduleOne(t, [t.conns[0]], nextMonth);
    expect(await used(t.ws, month(nextMonth))).toBe(1);
    // the usage view reports the current month's count against 10
    const ent = await workspaceEntitlements(t.ctx);
    expect(ent.allowances.find((a) => a.key === 'scheduled_posts')).toMatchObject({ hard_limit: 10, period_kind: 'period' });
  });

  it('publish now counts too, and the last unit is taken exactly once under concurrency', async () => {
    const t = await freeTenant();
    const now = new Date();
    // 9 posts this month (publish-now counts in the current month)
    for (let i = 0; i < 9; i++) await scheduleOne(t, [t.conns[0]], new Date(now.getTime() + (2 + i) * 60_000));
    const thisMonth = month(new Date(now.getTime() + 11 * 60_000));
    if (month(now) !== thisMonth) return; // run at a month boundary: the scenario does not apply this minute
    const ids = await Promise.all([1, 2, 3].map(async () => (await createPost(t.ctx, t.brandId, draft([t.conns[0]]), randomUUID())).id));
    const results = await Promise.allSettled(ids.map((id) => publishNow(t.ctx, id, { expected_version: 1, connection_ids: [t.conns[0]] }, randomUUID())));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'entitlement_required', details: { allowance: 'scheduled_posts' } });
    expect(await used(t.ws, month(now))).toBe(10);
  });

  it('a second brand, a third social account and any teammate are refused (“Upgrade to add teammates”)', async () => {
    const t = await freeTenant();
    await expect(createBrand(t.ctx, { name: 'Second' })).rejects.toMatchObject({ code: 'entitlement_required', details: { reason: 'allowance_exhausted', allowance: 'brands', limit: 1, upgrade_to: 'standard' } });
    await expect(connectMock(t.ctx, t.brandId, { provider: 'instagram', display_name: 'Third' })).rejects.toMatchObject({ code: 'entitlement_required', details: { allowance: 'social_accounts', limit: 2 } });
    await expect(createInvitation(t.ctx, { email: `x-${randomUUID().slice(0, 6)}@test.social-lite.test`, role: 'editor' } as never, randomUUID()))
      .rejects.toMatchObject({ code: 'entitlement_required', message: expect.stringMatching(/Free includes 1 user\. Upgrade to add teammates\./), details: { allowance: 'members', upgrade_to: 'standard' } });
    expect((await q(`SELECT 1 FROM invitations WHERE workspace_id=$1`, [t.ws])).length).toBe(0);
    expect((await q(`SELECT 1 FROM brands WHERE workspace_id=$1`, [t.ws])).length).toBe(1);
  });

  it('500 MB media and 20k AI tokens; features not in Free are refused; the data export always works', async () => {
    const t = await freeTenant();
    // 499 MB already stored: a 2 MB image no longer fits Free's 500 MB
    await testPool().query(`INSERT INTO usage_counters(workspace_id, meter, period, used) VALUES ($1,'storage.bytes','total',$2)`, [t.ws, 499 * 1024 * 1024]);
    await expect(createUploadIntent(t.ctx, { brand_id: t.brandId, filename: 'a.png', content_type: 'image/png', bytes: 2 * 1024 * 1024 }))
      .rejects.toMatchObject({ code: 'budget_exhausted', details: { meter: 'storage.bytes', cap: 500 * 1024 * 1024, limit_source: 'plan' } });
    await expect(reserveUsage({ workspaceId: t.ws, meter: 'ai.tokens', amount: 20_001 })).rejects.toMatchObject({ code: 'budget_exhausted', details: { cap: 20_000 } });
    await expect(reserveUsage({ workspaceId: t.ws, meter: 'ai.tokens', amount: 1_000 })).resolves.toBeTruthy();
    // analytics + inbox API areas (route gate), report exports, approvals, listening, MCP
    await expect(assertRouteEntitled('/api/analytics/overview', t.ws)).rejects.toMatchObject({ code: 'entitlement_required', details: { feature: 'analytics_standard', upgrade_to: 'standard' } });
    await expect(assertRouteEntitled('/api/analytics/exports', t.ws)).rejects.toMatchObject({ code: 'entitlement_required' });
    await expect(assertRouteEntitled('/api/inbox/conversations', t.ws)).rejects.toMatchObject({ code: 'entitlement_required', details: { feature: 'inbox' } });
    await expect(assertRouteEntitled('/api/posts', t.ws)).resolves.toBeUndefined();
    await expect(reserveUsage({ workspaceId: t.ws, meter: 'exports.count', amount: 1 })).rejects.toMatchObject({ code: 'budget_exhausted' }); // 0 report exports
    await expect(chargeMcpCall(t.ws, { tool: 'list_posts', readOnly: true, userId: t.owner.id })).rejects.toMatchObject({ code: 'entitlement_required', details: { feature: 'mcp' } });
    await expect(createSearch(t.ctx, { brand_id: t.brandId, name: 'Comp', role: 'competitor', terms: ['acme'], keywords: [], exclusions: [], boolean: null, languages: [], sources: [], kinds: [] } as never))
      .rejects.toMatchObject({ code: 'entitlement_required', details: { feature: 'listening' } });
    const pol = await getApprovalPolicy(t.ctx, t.brandId);
    await expect(saveApprovalPolicy(t.ctx, t.brandId, { expected_generation: pol.generation, separation_of_duties: false, stages: [{ name: 'Review', quorum: 1, eligible_roles: ['owner'] }] } as never))
      .rejects.toMatchObject({ code: 'entitlement_required', details: { feature: 'collaboration' } });
    const { id } = await createPost(t.ctx, t.brandId, draft([t.conns[0]]), randomUUID());
    await expect(submitForReview(t.ctx, id, { expected_version: 1, connection_ids: [t.conns[0]] }, randomUUID())).rejects.toMatchObject({ code: 'invalid_state' }); // no policy → schedule directly
    const ent = await workspaceEntitlements(t.ctx);
    for (const f of ['analytics_standard', 'inbox', 'collaboration', 'listening', 'automation', 'integrations_business', 'mcp'] as const) expect(ent.features[f].enabled, f).toBe(false);
    expect(ent.features.publishing.enabled).toBe(true);
    // the data export (activity log CSV) is never blocked by Free's 0 report exports
    await expect(activityCsv(t.ctx, {})).resolves.toBeTruthy();
  });
});
