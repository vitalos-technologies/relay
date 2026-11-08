// V3 manual handoff: a draft delivered to the creator's native app is a KNOWN state — not published,
// not ambiguous, not failed. It keeps being checked, can be resolved by a person, and is never auto-retried.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { aggregateStatus } from '@social-lite/core';
import { claimDelivery, createPost, processDelivery, publishNow, reconcileOne, resolveDelivery, retryDelivery } from '@social-lite/services';
import { closeTestPool, tenant, testPool } from './helpers.js';
import { scriptedWorld, seedConnections } from './engine-helpers.js';

afterAll(closeTestPool);

/** This post's delivery id (claims are scoped to it so parallel test files can't interfere). */
const deliveryOf = async (postId: string) => (await testPool().query<{ id: string }>(`SELECT id FROM deliveries WHERE post_id=$1`, [postId])).rows[0]!.id;
const claimOwn = async (postId: string) => claimDelivery('w', { deliveryId: await deliveryOf(postId) });

describe('manual handoff delivery state', () => {
  it('processing → handoff (polled hourly), resolvable by a person, never auto-retried', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const world = scriptedWorld();
    world.scripts.telegram = {
      publish: () => ({ kind: 'processing', providerIds: ['mock_pub_1'], checkAfterMs: 1000 }),
      reconcile: () => ({ kind: 'handoff', reason: 'Finish the post in the app.', providerIds: ['mock_pub_1'] }),
    };
    const { id } = await createPost(t.ownerCtx, t.brandId, { draft: { baseText: 'Handoff test', baseLink: null, baseAssetIds: [], variants: [{ connectionId: conns.telegram, inheritText: true, inheritMedia: true }] } }, randomUUID());
    await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.telegram] }, randomUUID());
    expect(await processDelivery(world.deps, (await claimOwn(id))!)).toBe('processing');
    await testPool().query(`UPDATE deliveries SET next_attempt_at=now() WHERE post_id=$1`, [id]);
    expect(await processDelivery(world.deps, (await claimOwn(id))!)).toBe('handoff');
    const d = (await testPool().query(`SELECT id, state, needs_reconcile, next_attempt_at > now() + interval '50 minutes' AS hourly FROM deliveries WHERE post_id=$1`, [id])).rows[0];
    expect(d).toMatchObject({ state: 'handoff', needs_reconcile: true, hourly: true });
    expect(aggregateStatus(['published', 'handoff'])).toBe('needs_attention');
    // not claimable for publishing; reconcile keeps it in handoff while the provider still reports a draft
    await testPool().query(`UPDATE deliveries SET next_attempt_at=now() WHERE id=$1`, [d.id]);
    expect(await claimDelivery('w', { deliveryId: d.id })).toBeNull();
    expect(await reconcileOne(world.deps, 'r', testPool(), { deliveryId: d.id })).toBe('handoff');
    // retry would create a second draft: refused; a person resolves it instead
    await expect(retryDelivery(t.ownerCtx, d.id, {})).rejects.toMatchObject({ code: 'invalid_state' });
    const resolved = await resolveDelivery(t.ownerCtx, d.id, { outcome: 'published', provider_url: 'https://example.invalid/post/1' });
    expect(resolved.state).toBe('published');
  });

  it('reconcile observing the provider post completes the handoff automatically', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const world = scriptedWorld();
    let posted = false;
    world.scripts.telegram = {
      publish: () => ({ kind: 'handoff', code: 'manual_handoff', message: 'Sent to the creator inbox.', providerIds: ['mock_pub_2'] }),
      reconcile: () => (posted ? { kind: 'published', providerIds: ['mock_pub_2', 'mock_post_9'] } : { kind: 'handoff', reason: 'Still a draft.' }),
    };
    const { id } = await createPost(t.ownerCtx, t.brandId, { draft: { baseText: 'Handoff 2', baseLink: null, baseAssetIds: [], variants: [{ connectionId: conns.telegram, inheritText: true, inheritMedia: true }] } }, randomUUID());
    await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.telegram] }, randomUUID());
    expect(await processDelivery(world.deps, (await claimOwn(id))!)).toBe('handoff');
    posted = true;
    await testPool().query(`UPDATE deliveries SET next_attempt_at=now() WHERE post_id=$1`, [id]);
    expect(await reconcileOne(world.deps, 'r', testPool(), { deliveryId: await deliveryOf(id) })).toBe('published');
    expect(world.publishCalls.size).toBe(1);
  });
});
