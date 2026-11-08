// Posts past their time that were not sent are labelled Overdue (never a calm "Scheduled"), and Home says whether
// the publisher is running.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createPost, schedulePost } from '@social-lite/services';
import { dashboard, history } from '@social-lite/services/readmodels';
import { toLocalInput } from '@social-lite/core';
import { closeTestPool, tenant, testPool } from './helpers.js';
import { seedConnections } from './engine-helpers.js';

afterAll(closeTestPool);

describe('overdue deliveries', () => {
  it('are flagged on Home, the agenda and history; publisher status is reported', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id } = await createPost(t.ownerCtx, t.brandId, { draft: { baseText: 'Late post', baseLink: null, baseAssetIds: [], variants: [conns.telegram, conns.facebook].map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) } }, randomUUID());
    await schedulePost(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.telegram, conns.facebook], input_local_time: toLocalInput(new Date(Date.now() + 3600_000), 'Europe/London'), timezone: 'Europe/London' }, randomUUID());

    let home = await dashboard(t.ownerCtx, {});
    expect(home.delayed.overdue).toBe(0);
    expect(home.today.find((i) => i.post_id === id)?.overdue).toBe(false);

    // the worker is down: the delivery's time passes without a claim
    await testPool().query(`UPDATE schedules SET due_at=now() - interval '10 minutes' WHERE post_id=$1`, [id]);
    await testPool().query(`UPDATE deliveries SET due_at=now() - interval '10 minutes', next_attempt_at=now() - interval '10 minutes' WHERE post_id=$1`, [id]);
    home = await dashboard(t.ownerCtx, {});
    expect(home.delayed).toMatchObject({ overdue: 1 }); // counts posts, not destinations
    expect(typeof home.delayed.publisher_running).toBe('boolean');
    const item = home.today.find((i) => i.post_id === id)!;
    expect(item).toMatchObject({ status: 'scheduled', overdue: true });
    expect(item.destinations[0]).toMatchObject({ state: 'scheduled', overdue: true });
    const h = await history(t.ownerCtx, { limit: 10, to: new Date(Date.now() + 60_000).toISOString() });
    expect(h.items.find((r) => r.post_id === id)).toMatchObject({ state: 'scheduled', overdue: true });
  });
});
