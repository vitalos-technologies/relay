// A mandatory brand rule added after scheduling HOLDS the delivery in the engine until a person decides:
// 'will_edit' keeps it held, 'keep' releases it, and nothing is sent while held.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { toLocalInput } from '@social-lite/core';
import { claimDelivery, createPost, processDelivery, schedulePost } from '@social-lite/services';
import { createBrandRule, decideRuleReview, listRuleReviews } from '@social-lite/services/gov/brand-rules';
import { closeTestPool, tenant, testPool } from './helpers.js';
import { scriptedWorld, seedConnections } from './engine-helpers.js';

afterAll(closeTestPool);

describe('brand-rule review hold', () => {
  it('holds a scheduled delivery while a mandatory rule review is open or "will edit"; "keep" releases it', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const world = scriptedWorld();
    const mk = async (text: string) => {
      const { id } = await createPost(t.ownerCtx, t.brandId, { draft: { baseText: text, baseLink: null, baseAssetIds: [], variants: [{ connectionId: conns.facebook, inheritText: true, inheritMedia: true }] } }, randomUUID());
      await schedulePost(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.facebook], input_local_time: toLocalInput(new Date(Date.now() + 3600_000), 'Europe/London'), timezone: 'Europe/London' }, randomUUID());
      return id;
    };
    const keepId = await mk('Weekend deals on espresso');
    const editId = await mk('More deals for members');
    await createBrandRule(t.ownerCtx, t.brandId, { kind: 'prohibited_phrase', value: 'deals', severity: 'mandatory' });
    const reviews = (await listRuleReviews(t.ownerCtx, t.brandId)).items.filter((r) => r.kind === 'schedule');
    expect(reviews).toHaveLength(2);
    const due = async (postId: string) => testPool().query(`UPDATE deliveries SET next_attempt_at=now() WHERE post_id=$1 AND state IN ('scheduled','blocked')`, [postId]);
    const state = async (postId: string) => (await testPool().query<{ state: string; last_error_code: string | null }>(`SELECT state, last_error_code FROM deliveries WHERE post_id=$1`, [postId])).rows[0]!;

    // open review ⇒ held, nothing sent
    await due(keepId);
    expect(await processDelivery(world.deps, (await claimDelivery('w', { deliveryId: (await testPool().query(`SELECT id FROM deliveries WHERE post_id=$1`, [keepId])).rows[0].id }))!)).toBe('blocked');
    expect(await state(keepId)).toEqual({ state: 'blocked', last_error_code: 'brand_rule_review' });
    expect(world.publishCalls.size).toBe(0);

    // 'will_edit' keeps the hold
    await decideRuleReview(t.ownerCtx, reviews.find((r) => r.post_id === editId)!.id, { decision: 'will_edit' });
    await due(editId);
    const editDelivery = (await testPool().query(`SELECT id FROM deliveries WHERE post_id=$1`, [editId])).rows[0].id;
    expect(await processDelivery(world.deps, (await claimDelivery('w', { deliveryId: editDelivery }))!)).toBe('blocked');

    // 'keep' releases it and it publishes
    await decideRuleReview(t.ownerCtx, reviews.find((r) => r.post_id === keepId)!.id, { decision: 'keep' });
    expect((await state(keepId)).state).toBe('scheduled');
    await due(keepId);
    const keepDelivery = (await testPool().query(`SELECT id FROM deliveries WHERE post_id=$1`, [keepId])).rows[0].id;
    expect(await processDelivery(world.deps, (await claimDelivery('w', { deliveryId: keepDelivery }))!)).toBe('published');
    expect(world.publishCalls.size).toBe(1);
    expect((await state(editId)).state).toBe('blocked');
  });
});
