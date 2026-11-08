// V4 ENT × BIL — the REAL billing state (getBillingState, no injection): a no-card trial gets bounded trial allowances;
// trial expiry (BIL sweep → billing.access_changed outbox event → worker event router) holds scheduled posts with a
// visible reason, keeps data, exports and support, and never sends anything (V5 §7 "trial expiry", brief §18.11/§18.15).
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { toLocalInput } from '@social-lite/core';
import { claimDelivery, createPost, processDelivery, schedulePost } from '@social-lite/services';
import { startTrialTx, sweepTrials } from '@social-lite/services/billing/trials';
import { handleEvent } from '@social-lite/services/engine/notify';
import { activityCsv } from '@social-lite/services/product/index';
import { workspaceEntitlements } from '@social-lite/services/entitlements/usage';
import { invalidateEntitlements } from '@social-lite/services/entitlements/resolve';
import { withTx } from '@social-lite/db';
import { closeTestPool, tenant, testPool, v2Ctx } from './helpers.js';
import { scriptedWorld, seedConnections } from './engine-helpers.js';

afterAll(closeTestPool);
const db = () => testPool();

describe('trial expiry with the real billing state', () => {
  it('trial ⇒ bounded allowances; expiry ⇒ access_changed ⇒ scheduled post held (not sent, not deleted); exports + support stay', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    await withTx((tx) => startTrialTx(tx, { workspaceId: t.workspaceId, planId: 'standard', userId: t.owner.id, source: 'onboarding' }));
    const ctx = await v2Ctx(t.owner.id, t.workspaceId);
    const during = await workspaceEntitlements(ctx);
    expect(during).toMatchObject({ plan: { id: 'standard' }, status: 'trialing', access: 'full', period: { kind: 'trial' } });
    expect(during.allowances.find((a) => a.key === 'ai_tokens')).toMatchObject({ included: 100_000, source: 'trial' });
    expect(during.features.listening.enabled).toBe(false);

    const { id } = await createPost(ctx, t.brandId, { draft: { baseText: 'Launch day', baseLink: null, baseAssetIds: [], variants: [{ connectionId: conns.facebook, inheritText: true, inheritMedia: true }] } }, randomUUID());
    await schedulePost(ctx, id, { expected_version: 1, connection_ids: [conns.facebook], input_local_time: toLocalInput(new Date(Date.now() + 3600_000), 'Europe/London'), timezone: 'Europe/London' }, randomUUID());

    // fast-forward the trial clock (test only), then BIL's sweep expires it and writes billing.* outbox events
    await db().query(`UPDATE workspace_billing SET trial_ends_at=now() - interval '1 minute' WHERE workspace_id=$1`, [t.workspaceId]);
    await sweepTrials(db());
    invalidateEntitlements();
    const events = await db().query<{ event_type: string; aggregate_id: string; payload: Record<string, unknown> }>(
      `SELECT event_type, aggregate_id, payload FROM outbox WHERE workspace_id=$1 AND event_type LIKE 'billing.%' ORDER BY id`, [t.workspaceId]);
    const changed = events.rows.find((e) => e.event_type === 'billing.access_changed');
    expect(changed).toBeTruthy();
    await handleEvent({ event_type: changed!.event_type, workspace_id: t.workspaceId, aggregate_id: changed!.aggregate_id, payload: changed!.payload });

    const d = (await db().query<{ id: string; state: string; last_error_code: string; blocked_reason: string }>(`SELECT id, state, last_error_code, blocked_reason FROM deliveries WHERE post_id=$1`, [id])).rows[0]!;
    expect(d).toMatchObject({ state: 'blocked', last_error_code: 'entitlement_hold' });
    expect(d.blocked_reason).toMatch(/^Held: /);
    // the worker re-checks at dispatch: still held, nothing sent
    const world = scriptedWorld();
    await db().query(`UPDATE deliveries SET state='scheduled', next_attempt_at=now() WHERE id=$1`, [d.id]);
    expect(await processDelivery(world.deps, (await claimDelivery('w', { deliveryId: d.id }))!)).toBe('blocked');
    expect(world.publishCalls.size).toBe(0);
    // data preserved; exports and the entitlement view (billing/support links) still work
    expect((await db().query(`SELECT count(*)::int n FROM posts WHERE id=$1 AND archived_at IS NULL`, [id])).rows[0].n).toBe(1);
    await expect(activityCsv(ctx, {})).resolves.toBeTruthy();
    const after = await workspaceEntitlements(ctx);
    expect(after).toMatchObject({ status: 'expired', access: 'restricted', held: { scheduled_posts: 1 } });
    expect(after.features.support.enabled).toBe(true);
  });
});
