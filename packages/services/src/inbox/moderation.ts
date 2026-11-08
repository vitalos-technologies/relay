// V3.5 stream B — moderation (brief §10 "moderation capabilities"): hide / unhide a customer's public comment and delete
// the business's OWN reply, only where the provider permits it (adapter.moderationActions). A customer's review or
// message is never deleted by Relay. Provider calls are idempotent (hiding twice = hidden), synchronous with a bounded
// timeout, recorded with their real outcome (done / failed + reason), audited, and never retried silently.
import { AppError, notFound } from '@social-lite/core';
import type { ModerationAction } from '@social-lite/core/contracts/v35-inbox';
import { getInboxAdapter } from '@social-lite/providers';
import { getPool, maybeOne, withTx } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { ChannelUnavailableError, channelRuntime } from './channels-runtime.js';
import { inboxEvent, loadChannelRow, loadConversation } from './shared.js';

export const moderateSchema = z.object({ action: z.enum(['hide', 'unhide', 'delete_own']) }).strict();

interface MsgRow { id: string; workspace_id: string; conversation_id: string; channel_id: string; direction: 'inbound' | 'outbound'; external_id: string | null; meta: Record<string, unknown>; hidden_at: Date | null; removed_at: Date | null; deleted_at: Date | null }

/** Actions offered on one message (empty when the provider permits none or the message cannot be addressed). */
export function moderationFor(kind: Parameters<NonNullable<ReturnType<typeof getInboxAdapter>>['replyRules']>[0]['kind'], channelKind: Parameters<typeof getInboxAdapter>[0], m: { direction: 'inbound' | 'outbound'; external_id: string | null; deleted_at: Date | null; removed_at: Date | null; hidden_at: Date | null }): ModerationAction[] {
  if (!m.external_id || m.deleted_at || m.removed_at) return [];
  const acts = getInboxAdapter(channelKind)?.moderationActions?.(kind, m.direction) ?? [];
  return acts.filter((a) => (a === 'hide' ? !m.hidden_at : a === 'unhide' ? !!m.hidden_at : true));
}

export async function moderateMessage(ctx: Ctx, messageId: string, action: ModerationAction): Promise<{ state: 'done' | 'failed'; message: string | null }> {
  if (!/^[0-9a-f-]{36}$/i.test(messageId)) throw notFound('Message');
  const m = await maybeOne<MsgRow>(getPool(), `SELECT id, workspace_id, conversation_id, channel_id, direction, external_id, meta, hidden_at, removed_at, deleted_at FROM inbox_messages WHERE id=$1 AND workspace_id=$2`, [messageId, ctx.access.workspaceId]);
  if (!m) throw notFound('Message');
  const conv = await loadConversation(ctx, m.conversation_id, 'inbox.reply');   // moderation is a customer-facing action
  const ch = await loadChannelRow(getPool(), m.channel_id);
  if (!ch || ch.disconnected_at) throw new AppError('invalid_state', 'This channel is no longer connected.');
  if (ch.status !== 'active') throw new AppError('invalid_state', ch.status === 'paused' ? 'This channel is paused.' : (ch.status_detail ?? 'This channel needs attention.'));
  if (!moderationFor(conv.kind, ch.kind, m).includes(action)) throw new AppError('invalid_state', action === 'delete_own' ? 'Only the business’s own replies can be deleted here.' : 'The network does not allow this here.', undefined, { reason: 'not_supported' });
  let result: Awaited<ReturnType<NonNullable<NonNullable<ReturnType<typeof getInboxAdapter>>['moderate']>>>;
  try {
    const rt = await channelRuntime(ch);
    result = await rt.adapter.moderate!(rt.ctx, rt.creds, rt.conn, { action, kind: conv.kind, externalId: m.external_id!, threadKey: conv.external_thread_id, meta: m.meta ?? {} });
  } catch (err) {
    if (!(err instanceof ChannelUnavailableError)) throw err;
    result = { ok: false, code: err.code, message: err.message, retryable: err.retryable };
  }
  await withTx(async (tx) => {
    await tx.query(`INSERT INTO inbox_moderation_actions(workspace_id, conversation_id, message_id, action, state, error_code, error_message, is_simulated, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [m.workspace_id, m.conversation_id, m.id, action, result.ok ? 'done' : 'failed', result.ok ? null : result.code.slice(0, 80), result.ok ? null : result.message.slice(0, 300), ch.is_simulated, ctx.actor.userId]);
    if (result.ok) {
      if (action === 'hide') await tx.query(`UPDATE inbox_messages SET hidden_at=now() WHERE id=$1`, [m.id]);
      if (action === 'unhide') await tx.query(`UPDATE inbox_messages SET hidden_at=NULL WHERE id=$1`, [m.id]);
      if (action === 'delete_own') await tx.query(`UPDATE inbox_messages SET removed_at=now() WHERE id=$1`, [m.id]);
      await tx.query(`UPDATE inbox_conversations SET version=version+1, updated_at=now() WHERE id=$1`, [m.conversation_id]);
    }
    await inboxEvent(tx, { workspaceId: m.workspace_id, conversationId: m.conversation_id, brandId: conv.brand_id, kind: result.ok ? `moderation.${action}` : 'moderation.failed', actorId: ctx.actor.userId, data: { message_id: m.id, action } });
    await audit(tx, { workspaceId: m.workspace_id, brandId: conv.brand_id, actorUserId: ctx.actor.userId, action: `inbox.moderation_${action}`, resourceType: 'inbox_message', resourceId: m.id, diff: { outcome: result.ok ? 'done' : 'failed', code: result.ok ? null : result.code }, correlationId: ctx.correlationId });
  });
  return result.ok ? { state: 'done', message: null } : { state: 'failed', message: result.message };
}
