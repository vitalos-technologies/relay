import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createPost, publishNow } from '@social-lite/services';
import { processWebhookReceipt } from '@social-lite/services/webhooks';
import { closeTestPool, tenant, testPool } from './helpers.js';
import { CAPS } from './engine-helpers.js';

afterAll(closeTestPool);

async function liveConn(t: Awaited<ReturnType<typeof tenant>>, provider: 'facebook' | 'telegram', account: string) {
  const r = await testPool().query<{ id: string }>(
    `INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, status, is_mock, capabilities)
     VALUES ($1,$2,$3,$4,'Live','ready',false,$5) RETURNING id`, [t.workspaceId, t.brandId, provider, account, JSON.stringify(CAPS[provider])]);
  return r.rows[0]!.id;
}

async function unknownDelivery(t: Awaited<ReturnType<typeof tenant>>, connId: string, text: string, providerIds: string[] = []) {
  const { id } = await createPost(t.ownerCtx, t.brandId, { draft: { baseText: text, baseLink: null, baseAssetIds: [], variants: [{ connectionId: connId, inheritText: true, inheritMedia: true }] } }, randomUUID());
  await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: [connId] }, randomUUID());
  const d = await testPool().query<{ id: string }>(`UPDATE deliveries SET state='unknown', unknown_since=now(), needs_reconcile=true, provider_ids=$2 WHERE post_id=$1 RETURNING id`, [id, providerIds]);
  return d.rows[0]!.id;
}

async function receipt(provider: string, body: object) {
  const r = await testPool().query<{ id: string }>(`INSERT INTO webhook_receipts(provider, digest, body) VALUES ($1,$2,$3) RETURNING id`, [provider, randomUUID(), JSON.stringify(body)]);
  return r.rows[0]!.id;
}

describe('webhook processing is forward-only', () => {
  it('Meta event with our post id confirms Unknown → Published; unrelated ids are ignored', async () => {
    const t = await tenant();
    const conn = await liveConn(t, 'facebook', '5550001');
    const d = await unknownDelivery(t, conn, 'Meta hello', ['5550001_42']);
    expect(await processWebhookReceipt(await receipt('meta', { entry: [{ changes: [{ value: { post_id: '999_1' } }] }] }))).toEqual({ confirmed: 0, state: 'ignored' });
    expect(await processWebhookReceipt(await receipt('meta', { entry: [{ changes: [{ value: { post_id: '5550001_42' } }] }] }))).toEqual({ confirmed: 1, state: 'processed' });
    expect((await testPool().query(`SELECT state FROM deliveries WHERE id=$1`, [d])).rows[0].state).toBe('published');
  });

  it('Telegram channel_post resolves exactly one matching Unknown; ambiguity leaves it Unknown', async () => {
    const t = await tenant();
    const conn = await liveConn(t, 'telegram', '-1007770001');
    const d = await unknownDelivery(t, conn, 'Weekly update is live');
    const now = Math.floor(Date.now() / 1000);
    await processWebhookReceipt(await receipt('telegram', { update_id: 1, channel_post: { chat: { id: -1007770001 }, message_id: 77, text: 'Weekly update is live\n\nhttps://example.com', date: now } }));
    expect((await testPool().query(`SELECT state, provider_ids FROM deliveries WHERE id=$1`, [d])).rows[0]).toMatchObject({ state: 'published', provider_ids: ['77'] });
    const a = await unknownDelivery(t, conn, 'Same text');
    const b = await unknownDelivery(t, conn, 'Same text');
    await processWebhookReceipt(await receipt('telegram', { update_id: 2, channel_post: { chat: { id: -1007770001 }, message_id: 78, text: 'Same text', date: now } }));
    const rows = await testPool().query(`SELECT state FROM deliveries WHERE id = ANY($1::uuid[])`, [[a, b]]);
    expect(rows.rows.map((r) => r.state)).toEqual(['unknown', 'unknown']);
  });

  it('never regresses a terminal state', async () => {
    const t = await tenant();
    const conn = await liveConn(t, 'facebook', '5550002');
    const d = await unknownDelivery(t, conn, 'x', ['5550002_1']);
    await testPool().query(`UPDATE deliveries SET state='failed' WHERE id=$1`, [d]);
    await processWebhookReceipt(await receipt('meta', { entry: [{ changes: [{ value: { post_id: '5550002_1' } }] }] }));
    expect((await testPool().query(`SELECT state FROM deliveries WHERE id=$1`, [d])).rows[0].state).toBe('failed');
  });
});
