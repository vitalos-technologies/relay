// Simulated inbound messages for SIMULATED (mock_) channels only — demo, E2E and integration tests. Disabled in
// production and when mock providers are off. The payload goes through the same parser + ingestion as a verified Meta
// webhook (only the signature step is skipped, because nothing left this server). Rows are flagged is_simulated.
import { randomUUID } from 'node:crypto';
import { AppError } from '@social-lite/core';
import { recordSimulatedInbound } from '@social-lite/providers/meta/inbox-fake';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { config, mockProvidersEnabled } from '../config.js';
import { getPool } from '@social-lite/db';
import { DbMockStore } from '../mock-store.js';
import { loadChannelFor } from './channels.js';
import { ingestProviderPayload } from './ingest.js';

export const simulateSchema = z.object({
  kind: z.enum(['dm', 'comment']),
  text: z.string().trim().min(1).max(2000),
  name: z.string().trim().min(1).max(80).optional(),
  /** Continue an existing simulated thread (PSID or top-level comment id). */
  thread: z.string().regex(/^mock_[A-Za-z0-9_]{3,80}$/).optional(),
  /** Backdate (tests: reply-window expiry). Minutes in the past. */
  minutes_ago: z.number().int().min(0).max(60 * 24 * 30).optional(),
}).strict();

export async function simulateInbound(ctx: Ctx, channelId: string, input: z.infer<typeof simulateSchema>): Promise<{ thread: string; external_id: string }> {
  if (config().APP_ENV === 'production' || !mockProvidersEnabled()) throw new AppError('forbidden', 'Simulated messages are disabled in this environment.');
  const ch = await loadChannelFor(ctx, channelId, 'inbox.manage');
  if (!ch.is_simulated || ch.kind !== 'facebook_page' || !ch.external_account_id.startsWith('mock_')) throw new AppError('invalid_state', 'Only simulated channels accept simulated messages.');
  const at = new Date(Date.now() - (input.minutes_ago ?? 0) * 60_000);
  const pageId = ch.external_account_id;
  const store = new DbMockStore();
  const tag = randomUUID().replace(/-/g, '').slice(0, 12);
  let body: unknown;
  let thread: string;
  let externalId: string;
  if (input.kind === 'dm') {
    thread = input.thread ?? `mock_psid_${tag}`;
    externalId = `mock_mid_${tag}`;
    await recordSimulatedInbound({ store }, pageId, { kind: 'dm', mid: externalId, psid: thread, text: input.text, at: at.toISOString() });
    body = { object: 'page', entry: [{ id: pageId, time: at.getTime(), messaging: [{ sender: { id: thread }, recipient: { id: pageId }, timestamp: at.getTime(), message: { mid: externalId, text: input.text } }] }] };
  } else {
    externalId = `mock_c_${tag}`;
    const parent = input.thread ?? null;
    thread = parent ?? externalId;
    const fromId = `mock_user_${tag}`;
    const postId = `${pageId}_mock_post`;
    await recordSimulatedInbound({ store }, pageId, { kind: 'comment', commentId: externalId, parentId: parent, postId, fromId, fromName: input.name ?? 'Simulated customer', text: input.text, at: at.toISOString() });
    body = { object: 'page', entry: [{ id: pageId, time: at.getTime(), changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: externalId, post_id: postId, parent_id: parent ?? postId, message: input.text, from: { id: fromId, name: input.name ?? 'Simulated customer' }, created_time: Math.floor(at.getTime() / 1000) } }] }] };
  }
  await ingestProviderPayload('facebook_page', body, { simulated: true });
  if (input.kind === 'dm' && input.name) {
    await getPool().query(`UPDATE inbox_contacts SET display_name=$3 WHERE channel_id=$1 AND external_id=$2`, [ch.id, thread, input.name]);
  }
  await audit(getPool(), { workspaceId: ch.workspace_id, brandId: ch.brand_id, actorUserId: ctx.actor.userId, action: 'inbox.simulated_message', resourceType: 'inbox_channel', resourceId: ch.id, diff: { kind: input.kind }, correlationId: ctx.correlationId });
  return { thread, external_id: externalId };
}
