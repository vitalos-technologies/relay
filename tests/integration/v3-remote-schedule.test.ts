// V3 provider-native scheduling (spec §7) against REAL PostgreSQL: a provider-held release (YouTube publishAt) is
// recorded as scheduling_owner='provider'; it is not timed out while the release is pending; an emergency pause
// attempts remote cancellation and either cancels the delivery or keeps it visible with the residual risk.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { RemoteScheduleCancelOutcome } from '@social-lite/core';
import { claimDelivery, createPost, onScopePaused, processDelivery, publishNow, type EngineDeps } from '@social-lite/services';
import { closeTestPool, tenant, testPool } from './helpers.js';
import { scriptedWorld, seedConnections } from './engine-helpers.js';

afterAll(closeTestPool);

async function drain(deps: EngineDeps, max = 10): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const c = await claimDelivery('w-remote');
    if (!c) break;
    out.push(await processDelivery(deps, c));
  }
  return out;
}

beforeEach(async () => {
  await testPool().query(`UPDATE deliveries SET state='cancelled' WHERE state IN ('scheduled','retry_wait','processing','preparing','publishing')`);
  await testPool().query(`UPDATE system_flags SET value='true' WHERE key='dispatch_enabled'`);
  await testPool().query(`DELETE FROM provider_circuits`);
});

async function heldRelease(cancel: (calls: number) => RemoteScheduleCancelOutcome) {
  const t = await tenant();
  const conns = await seedConnections(t.workspaceId, t.brandId);
  const world = scriptedWorld();
  const publishAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
  world.scripts.x = {
    publish: () => ({ kind: 'processing', providerIds: ['mock_vid_1'], checkAfterMs: 1000, checkpoint: { step: 'uploaded', data: { remoteSchedule: { provider: 'youtube', publishAt, videoId: 'mock_vid_1' } } } }),
    reconcile: () => ({ kind: 'processing', checkAfterMs: 3_600_000 }),
  };
  let cancelCalls = 0;
  const base = world.deps.adapterFor;
  const deps: EngineDeps = { ...world.deps, adapterFor: (p) => ({ ...base(p), cancelRemoteSchedule: async () => cancel(++cancelCalls) }) };
  const draft = { baseText: 'Premiere', baseLink: null, baseAssetIds: [], variants: [{ connectionId: conns.x, inheritText: true, inheritMedia: true }] };
  const { id } = await createPost(t.ownerCtx, t.brandId, { title: 'Held', draft }, randomUUID());
  await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.x] }, randomUUID());
  expect(await drain(deps)).toEqual(['processing']);
  const row = async () => (await testPool().query<{ id: string; state: string; scheduling_owner: string; remote_schedule: Record<string, unknown> | null; last_error_code: string | null; last_error_message: string | null; next_attempt_at: Date }>(
    `SELECT id, state, scheduling_owner, remote_schedule, last_error_code, last_error_message, next_attempt_at FROM deliveries WHERE post_id=$1`, [id])).rows[0]!;
  return { t, deps, row, publishAt, cancels: () => cancelCalls };
}

describe('provider-held release (scheduling owner = provider)', () => {
  it('is recorded on the first poll and is not timed out while the release is pending', async () => {
    const h = await heldRelease(() => ({ kind: 'cancelled', message: 'x' }));
    const d = await h.row();
    await testPool().query(`UPDATE deliveries SET next_attempt_at=now() - interval '1 second', due_at=now() - interval '3 hours' WHERE id=$1`, [d.id]);
    expect(await drain(h.deps)).toEqual(['processing']); // no 2 h "processing_timeout" for a pending provider release
    expect(await h.row()).toMatchObject({ state: 'processing', scheduling_owner: 'provider', remote_schedule: { provider: 'youtube', publishAt: h.publishAt, state: 'scheduled' } });
    expect(h.cancels()).toBe(0);
  });

  it('pause wakes the delivery, cancels the remote release and cancels the delivery', async () => {
    const h = await heldRelease(() => ({ kind: 'cancelled', message: 'The scheduled YouTube release was cancelled; the video stays private.' }));
    await testPool().query(`UPDATE brands SET publishing_paused=true WHERE id=$1`, [h.t.brandId]);
    await onScopePaused(testPool(), { workspaceId: h.t.workspaceId, brandId: h.t.brandId });
    expect((await h.row()).next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await drain(h.deps)).toEqual(['cancelled']);
    expect(h.cancels()).toBe(1);
    expect(await h.row()).toMatchObject({ state: 'cancelled', scheduling_owner: 'provider', last_error_code: 'remote_schedule_cancelled', remote_schedule: { state: 'cancelled' } });
  });

  it('an unconfirmed cancellation keeps the delivery visible with the residual risk and retries', async () => {
    const h = await heldRelease(() => ({ kind: 'uncertain', scheduledFor: null, message: 'Could not cancel the scheduled YouTube release; cancel it in YouTube Studio.' }));
    await testPool().query(`UPDATE brands SET publishing_paused=true WHERE id=$1`, [h.t.brandId]);
    await onScopePaused(testPool(), { workspaceId: h.t.workspaceId, brandId: h.t.brandId });
    expect(await drain(h.deps)).toEqual(['processing']);
    const d = await h.row();
    expect(d).toMatchObject({ state: 'processing', last_error_code: 'remote_schedule_uncertain', remote_schedule: { state: 'uncertain' } });
    expect(d.last_error_message).toMatch(/Paused, but the provider may still publish/);
    expect(d.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
  });
});
