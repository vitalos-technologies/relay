// V4 ENT × BIL with D33 — the REAL billing state (getBillingState, no injection): a no-card trial gets bounded trial
// allowances; when it ends without a subscription the workspace drops to FREE (BIL sweep → billing.* outbox events →
// worker event router → holds re-evaluated). Over Free's limits is paused, never deleted or disconnected: extra brands
// and accounts are held (their posts are held with a visible reason), scheduled posts beyond the month's allowance are
// held, extra members lose product access; the owner keeps full access, billing/support/export stay available.
// Upgrading releases everything (nothing duplicated).
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { toLocalInput } from '@social-lite/core';
import { claimDelivery, createPost, processDelivery, schedulePost } from '@social-lite/services';
import { startTrialTx, sweepTrials } from '@social-lite/services/billing/trials';
import { getBillingState } from '@social-lite/services/billing/state';
import { startCheckout } from '@social-lite/services/billing/manage';
import { completeTestCheckout } from '@social-lite/services/billing/test-provider';
import { setBillingProviderForTests } from '@social-lite/services/billing/provider';
import { handleEvent } from '@social-lite/services/engine/notify';
import { activityCsv } from '@social-lite/services/product/index';
import { listSelections, workspaceEntitlements } from '@social-lite/services/entitlements/usage';
import { invalidateEntitlements, reevaluateHolds } from '@social-lite/services/entitlements/index';
import { withTx } from '@social-lite/db';
import { addMember, closeTestPool, createBrand, createUser, tenant, testPool, v2Ctx } from './helpers.js';
import { scriptedWorld, seedConnections } from './engine-helpers.js';

afterAll(closeTestPool);
const db = () => testPool();
const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db().query(sql, p)).rows as T[];

async function routeBillingEvents(ws: string, since: number) {
  const events = await q<{ id: string; event_type: string; aggregate_id: string; payload: Record<string, unknown> }>(
    `SELECT id::text, event_type, aggregate_id, payload FROM outbox WHERE workspace_id=$1 AND event_type LIKE 'billing.%' AND id > $2 ORDER BY id`, [ws, since]);
  for (const e of events) await handleEvent({ event_type: e.event_type, workspace_id: ws, aggregate_id: e.aggregate_id, payload: e.payload });
  return events.map((e) => e.event_type);
}
const lastOutbox = async () => Number((await q<{ n: string }>(`SELECT coalesce(max(id),0) n FROM outbox`))[0]!.n);

describe('trial end without a subscription → Free (D33)', () => {
  it('drops to Free; holds what is over the limits (brands, accounts, posts, members); deletes nothing; export works; upgrade releases', async () => {
    setBillingProviderForTests(undefined);
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId); // 4 accounts on brand 1 (instagram, facebook, telegram, x)
    const brand2 = await createBrand(t.workspaceId, 'Second brand');
    const b2conn = (await q<{ id: string }>(`INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, username, status, is_mock, capabilities)
      SELECT workspace_id, $2, provider, 'mock_b2_' || substr(md5(random()::text), 1, 8), 'Brand 2 page', 'b2', status, is_mock, capabilities FROM connections WHERE id=$1 RETURNING id`, [conns.facebook, brand2]))[0]!.id;
    const ed1 = await createUser(); await addMember(t.workspaceId, ed1.id, 'editor');
    const ed2 = await createUser(); await addMember(t.workspaceId, ed2.id, 'editor');
    await withTx((tx) => startTrialTx(tx, { workspaceId: t.workspaceId, planId: 'professional', userId: t.owner.id, source: 'onboarding' }));
    const ctx = await v2Ctx(t.owner.id, t.workspaceId);
    const during = await workspaceEntitlements(ctx);
    expect(during).toMatchObject({ plan: { id: 'professional' }, status: 'trialing', access: 'full', period: { kind: 'trial' } });
    expect(during.allowances.find((a) => a.key === 'ai_tokens')).toMatchObject({ included: 100_000, source: 'trial' });

    // during the trial: 12 posts on the facebook page (Free allows 10 a month), one on brand 2, one on the X account
    const base = Date.now() + 2 * 3600_000;
    const posts: string[] = [];
    const schedule = async (brandId: string, connectionId: string, i: number) => {
      const { id } = await createPost(ctx, brandId, { draft: { baseText: `Post ${i}`, baseLink: null, baseAssetIds: [], variants: [{ connectionId, inheritText: true, inheritMedia: true }] } }, randomUUID());
      await schedulePost(ctx, id, { expected_version: 1, connection_ids: [connectionId], input_local_time: toLocalInput(new Date(base + i * 60_000), 'Europe/London'), timezone: 'Europe/London' }, randomUUID());
      return id;
    };
    for (let i = 0; i < 12; i++) posts.push(await schedule(t.brandId, conns.facebook, i));
    const onBrand2 = await schedule(brand2, b2conn, 20);
    const onX = await schedule(t.brandId, conns.x, 21);
    const before = (await q<{ posts: number; conns: number; brands: number; members: number }>(
      `SELECT (SELECT count(*)::int FROM posts WHERE workspace_id=$1 AND archived_at IS NULL) posts,
              (SELECT count(*)::int FROM connections WHERE workspace_id=$1 AND disconnected_at IS NULL) conns,
              (SELECT count(*)::int FROM brands WHERE workspace_id=$1 AND archived_at IS NULL) brands,
              (SELECT count(*)::int FROM memberships WHERE workspace_id=$1 AND status='active' AND removed_at IS NULL) members`, [t.workspaceId]))[0]!;

    // the trial ends (test clock) → BIL sweep → Free; the worker routes billing.* events to ENT
    const mark = await lastOutbox();
    await db().query(`UPDATE workspace_billing SET trial_ends_at=now() - interval '1 minute' WHERE workspace_id=$1`, [t.workspaceId]);
    await sweepTrials(db());
    invalidateEntitlements();
    expect(await routeBillingEvents(t.workspaceId, mark)).toEqual(expect.arrayContaining(['billing.trial_expired', 'billing.subscription_changed']));
    expect(await getBillingState(db(), t.workspaceId)).toMatchObject({ status: 'free', plan_id: 'free', access: 'full' });

    // held, with reasons — nothing deleted or disconnected
    const ent = await workspaceEntitlements(ctx);
    expect(ent).toMatchObject({ plan: { id: 'free' }, status: 'free', access: 'full', member_hold: null,
      held: { held_social_accounts: 3, held_brands: 1, held_members: 2 } });
    const st = async (postId: string) => (await q<{ state: string; last_error_code: string | null; blocked_reason: string | null }>(`SELECT state, last_error_code, blocked_reason FROM deliveries WHERE post_id=$1`, [postId]))[0]!;
    for (const p of posts.slice(0, 10)) expect((await st(p)).state).toBe('scheduled');
    for (const p of posts.slice(10)) expect(await st(p)).toMatchObject({ state: 'blocked', last_error_code: 'entitlement_hold', blocked_reason: expect.stringMatching(/scheduled posts? a month/) });
    expect(await st(onBrand2)).toMatchObject({ state: 'blocked', last_error_code: 'entitlement_hold' });
    expect(await st(onX)).toMatchObject({ state: 'blocked', blocked_reason: expect.stringMatching(/connected accounts/) });
    expect(ent.held.scheduled_posts).toBe(4);
    const after = (await q<typeof before>(
      `SELECT (SELECT count(*)::int FROM posts WHERE workspace_id=$1 AND archived_at IS NULL) posts,
              (SELECT count(*)::int FROM connections WHERE workspace_id=$1 AND disconnected_at IS NULL) conns,
              (SELECT count(*)::int FROM brands WHERE workspace_id=$1 AND archived_at IS NULL) brands,
              (SELECT count(*)::int FROM memberships WHERE workspace_id=$1 AND status='active' AND removed_at IS NULL) members`, [t.workspaceId]))[0]!;
    expect(after).toEqual(before);
    // the downgrade chooser lists brands and people too (owner always keeps access)
    const sel = await listSelections(ctx);
    expect(sel.items.find((s) => s.allowance === 'members')).toMatchObject({ limit: 1, over_limit: true, items: expect.arrayContaining([expect.objectContaining({ id: t.owner.id, active: true })]) });
    expect(sel.items.find((s) => s.allowance === 'brands')).toMatchObject({ limit: 1, over_limit: true });

    // extra members: product access paused, account kept; the owner keeps full access
    const edCtx = await v2Ctx(ed1.id, t.workspaceId);
    expect(edCtx.access.memberHold).toMatch(/includes 1 user/);
    expect(edCtx.access.brandIds).toEqual([]);
    await expect(createPost(edCtx, t.brandId, { draft: { baseText: 'x', baseLink: null, baseAssetIds: [], variants: [] } }, randomUUID()))
      .rejects.toMatchObject({ code: 'entitlement_required', details: { reason: 'over_limit_held', allowance: 'members' } });
    expect((await workspaceEntitlements(edCtx)).member_hold).toMatch(/Ask the owner to upgrade/);
    expect(ctx.access.memberHold).toBeUndefined();

    // dispatch: an allowed post publishes; an over-allowance post is re-checked and stays held (nothing sent)
    const world = scriptedWorld();
    const ok = (await q<{ id: string }>(`SELECT id FROM deliveries WHERE post_id=$1`, [posts[0]]))[0]!.id;
    await db().query(`UPDATE deliveries SET due_at=now(), next_attempt_at=now() WHERE id=$1`, [ok]);
    expect(await processDelivery(world.deps, (await claimDelivery('w', { deliveryId: ok }))!)).toBe('published');
    const heldId = (await q<{ id: string }>(`SELECT id FROM deliveries WHERE post_id=$1`, [posts[11]]))[0]!.id;
    await db().query(`UPDATE deliveries SET state='scheduled', next_attempt_at=now() WHERE id=$1`, [heldId]);
    expect(await processDelivery(world.deps, (await claimDelivery('w', { deliveryId: heldId }))!)).toBe('blocked');
    expect(world.publishCalls.size).toBe(1);

    // the workspace data export always works on Free (Free includes 0 report exports)
    await expect(activityCsv(ctx, {})).resolves.toBeTruthy();

    // upgrade (trial already used → straight to paid) → everything is released, nothing duplicated
    const c = await startCheckout(ctx, { plan: 'professional', seats: 3 });
    const mark2 = await lastOutbox();
    await completeTestCheckout(new URL(c.url).searchParams.get('session')!, 'paid');
    invalidateEntitlements();
    await routeBillingEvents(t.workspaceId, mark2);
    await reevaluateHolds(t.workspaceId);
    expect(await getBillingState(db(), t.workspaceId)).toMatchObject({ status: 'active', plan_id: 'professional' });
    const freed = await workspaceEntitlements(ctx);
    expect(freed.held).toMatchObject({ scheduled_posts: 0, held_social_accounts: 0, held_brands: 0, held_members: 0 });
    for (const p of [...posts.slice(1), onBrand2, onX]) expect((await st(p)).state).toBe('scheduled');
    expect((await v2Ctx(ed1.id, t.workspaceId)).access.memberHold).toBeUndefined();
  });
});
