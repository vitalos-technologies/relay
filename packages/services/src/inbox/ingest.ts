// Inbound inbox processing (brief §13). Called for VERIFIED provider payloads only (signature checked by the webhook
// ingress — services/webhooks.ts for Meta) and for simulated payloads on mock_ channels. Rules:
//  - persisted before anything else happens; duplicates are no-ops (UNIQUE(channel_id, external_id));
//  - ordering follows the provider timestamp, not arrival; late items never move the preview backwards;
//  - edits keep the previous text as a revision; provider deletions remove the body (retention), keep the row;
//  - delivery/read state only from provider receipts;
//  - echoes of Relay's own sends match by provider id; other business-side replies count as replies (collision checks).
// Message bodies are untrusted customer content: stored and displayed as text, never interpreted.
import type { ChannelKind, ConversationKind, InboundItem } from '@social-lite/core/contracts/v35-inbox';
import { getInboxAdapter } from '@social-lite/providers';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import { writeOutbox } from '../outbox.js';
import { onBusinessReply, onCustomerMessage } from './cases.js';
import { clipPreview, inboxEvent, type ChannelRow, type ConversationRow } from './shared.js';

export interface IngestResult { messages: number; duplicates: number; edits: number; deletes: number; receipts: number; unrouted: number }

const RANK = { sent: 1, delivered: 2, read: 3 } as const;

export async function ingestProviderPayload(kind: ChannelKind, body: unknown, opts: { simulated: boolean }): Promise<IngestResult> {
  const adapter = getInboxAdapter(kind);
  if (!adapter) return { messages: 0, duplicates: 0, edits: 0, deletes: 0, receipts: 0, unrouted: 0 };
  return ingestItems(kind, adapter.parseWebhook(body), opts);
}

export async function ingestItems(kind: ChannelKind, items: InboundItem[], opts: { simulated: boolean }): Promise<IngestResult> {
  const res: IngestResult = { messages: 0, duplicates: 0, edits: 0, deletes: 0, receipts: 0, unrouted: 0 };
  const channelCache = new Map<string, ChannelRow[]>();
  for (const item of items) {
    let chans = channelCache.get(item.accountId);
    if (!chans) {
      chans = await many<ChannelRow>(getPool(), `SELECT * FROM inbox_channels WHERE kind=$1 AND external_account_id=$2 AND disconnected_at IS NULL AND is_simulated=$3`, [kind, item.accountId, opts.simulated]);
      channelCache.set(item.accountId, chans);
    }
    if (!chans.length) { res.unrouted++; continue; }
    for (const ch of chans) {
      if (item.type === 'message') {
        if (!ch.enabled_types.includes(item.conversationKind)) { res.unrouted++; continue; }
        const r = await withTx((tx) => ingestMessage(tx, ch, item));
        if (r === 'duplicate') res.duplicates++; else res.messages++;
      } else if (item.type === 'edit') {
        if (await withTx((tx) => applyEdit(tx, ch, item))) res.edits++;
      } else if (item.type === 'delete') {
        if (await withTx((tx) => applyDelete(tx, ch, item))) res.deletes++;
      } else {
        res.receipts += await applyReceipt(getPool(), ch, item);
      }
    }
  }
  return res;
}

async function ingestMessage(tx: Queryable, ch: ChannelRow, m: Extract<InboundItem, { type: 'message' }>): Promise<'new' | 'duplicate'> {
  const at = new Date(m.occurredAt);
  const inbound = m.direction === 'inbound';
  let contactId: string | null = null;
  if (inbound && m.author) {
    const c = await one<{ id: string }>(tx,
      `INSERT INTO inbox_contacts(workspace_id, channel_id, external_id, display_name, handle) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (channel_id, external_id) DO UPDATE SET display_name=coalesce(EXCLUDED.display_name, inbox_contacts.display_name),
              handle=coalesce(EXCLUDED.handle, inbox_contacts.handle), last_seen_at=greatest(inbox_contacts.last_seen_at, now()) RETURNING id`,
      [ch.workspace_id, ch.id, m.author.externalId.slice(0, 200), m.author.name, m.author.handle]);
    contactId = c.id;
  }
  const visibility = m.conversationKind === 'dm' ? 'private' : 'public';
  const conv = await one<ConversationRow>(tx,
    `INSERT INTO inbox_conversations(workspace_id, brand_id, channel_id, kind, visibility, external_thread_id, contact_id, related_external_post_id, subject, last_message_at, is_simulated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (channel_id, kind, external_thread_id) DO UPDATE SET contact_id=coalesce(inbox_conversations.contact_id, EXCLUDED.contact_id), updated_at=now()
     RETURNING *`,
    [ch.workspace_id, ch.brand_id, ch.id, m.conversationKind satisfies ConversationKind, visibility, m.threadKey.slice(0, 300), contactId, m.relatedPostExternalId, m.subject, at, ch.is_simulated]);
  await tx.query(`SELECT 1 FROM inbox_conversations WHERE id=$1 FOR UPDATE`, [conv.id]);
  const ins = await maybeOne<{ id: string }>(tx,
    `INSERT INTO inbox_messages(workspace_id, conversation_id, channel_id, direction, external_id, parent_external_id, author_contact_id, body, attachments, provider_created_at, delivery_state, is_simulated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (channel_id, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING id`,
    [ch.workspace_id, conv.id, ch.id, m.direction, m.externalId.slice(0, 300), m.parentExternalId, contactId, m.text, JSON.stringify(m.attachments), at, inbound ? null : 'sent', ch.is_simulated]);
  if (!ins) return 'duplicate';
  const newest = at >= conv.last_message_at;
  if (inbound) {
    const reopen = conv.status === 'resolved' || conv.status === 'snoozed' || conv.status === 'waiting';
    await tx.query(
      `UPDATE inbox_conversations SET version=version+1, last_message_at=greatest(last_message_at, $2), last_inbound_at=greatest(coalesce(last_inbound_at, $2), $2),
              first_inbound_at=coalesce(first_inbound_at, $2), unanswered_since=coalesce(unanswered_since, $2),
              preview=CASE WHEN $3 THEN $4 ELSE preview END, status=CASE WHEN $5 THEN 'open' ELSE status END, snoozed_until=CASE WHEN $5 THEN NULL ELSE snoozed_until END,
              resolved_at=CASE WHEN $5 THEN NULL ELSE resolved_at END, updated_at=now() WHERE id=$1`,
      [conv.id, at, newest, clipPreview(m.text), reopen]);
    await tx.query(`UPDATE inbox_messages SET conv_version=(SELECT version FROM inbox_conversations WHERE id=$2) WHERE id=$1`, [ins.id, conv.id]);
    if (conv.case_id) await onCustomerMessage(tx, conv.case_id, at);
    await inboxEvent(tx, { workspaceId: ch.workspace_id, conversationId: conv.id, brandId: ch.brand_id, kind: 'message.received', data: { message_id: ins.id, reopened: reopen } });
    await writeOutbox(tx, { workspaceId: ch.workspace_id, aggregateType: 'inbox_conversation', aggregateId: conv.id, eventType: 'inbox.message_received', payload: { messageId: ins.id, channelId: ch.id, kind: m.conversationKind } });
    await tx.query(`UPDATE inbox_channels SET last_inbound_at=greatest(coalesce(last_inbound_at, $2), $2) WHERE id=$1`, [ch.id, at]);
  } else {
    // A business-side reply made outside Relay (or an echo that arrived before Relay recorded its own send).
    await tx.query(
      `UPDATE inbox_conversations SET version=version+1, last_message_at=greatest(last_message_at, $2), last_outbound_at=greatest(coalesce(last_outbound_at, $2), $2),
              unanswered_since=CASE WHEN unanswered_since IS NOT NULL AND unanswered_since <= $2 THEN NULL ELSE unanswered_since END,
              preview=CASE WHEN $3 THEN $4 ELSE preview END, updated_at=now() WHERE id=$1`, [conv.id, at, newest, clipPreview(m.text)]);
    await tx.query(`UPDATE inbox_messages SET conv_version=(SELECT version FROM inbox_conversations WHERE id=$2) WHERE id=$1`, [ins.id, conv.id]);
    if (conv.case_id) await onBusinessReply(tx, conv.case_id, at, false);
    await inboxEvent(tx, { workspaceId: ch.workspace_id, conversationId: conv.id, brandId: ch.brand_id, kind: 'message.outside_reply', data: { message_id: ins.id } });
  }
  return 'new';
}

async function applyEdit(tx: Queryable, ch: ChannelRow, e: Extract<InboundItem, { type: 'edit' }>): Promise<boolean> {
  const msg = await maybeOne<{ id: string; body: string | null; revision: number; conversation_id: string }>(tx,
    `SELECT id, body, revision, conversation_id FROM inbox_messages WHERE channel_id=$1 AND external_id=$2 AND deleted_at IS NULL FOR UPDATE`, [ch.id, e.externalId]);
  if (!msg || msg.body === e.text) return false;
  await tx.query(`INSERT INTO inbox_message_revisions(workspace_id, message_id, revision, body) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [ch.workspace_id, msg.id, msg.revision, msg.body]);
  await tx.query(`UPDATE inbox_messages SET body=$2, revision=revision+1, edited_at=$3 WHERE id=$1`, [msg.id, e.text, new Date(e.occurredAt)]);
  await tx.query(`UPDATE inbox_conversations SET version=version+1, updated_at=now() WHERE id=$1`, [msg.conversation_id]);
  await inboxEvent(tx, { workspaceId: ch.workspace_id, conversationId: msg.conversation_id, brandId: ch.brand_id, kind: 'message.edited', data: { message_id: msg.id } });
  return true;
}

async function applyDelete(tx: Queryable, ch: ChannelRow, e: Extract<InboundItem, { type: 'delete' }>): Promise<boolean> {
  const msg = await maybeOne<{ id: string; conversation_id: string }>(tx,
    `UPDATE inbox_messages SET deleted_at=$3, body=NULL WHERE channel_id=$1 AND external_id=$2 AND deleted_at IS NULL RETURNING id, conversation_id`, [ch.id, e.externalId, new Date(e.occurredAt)]);
  if (!msg) return false;
  // Earlier revisions of a deleted message are erased too (the customer removed it).
  await tx.query(`UPDATE inbox_message_revisions SET body=NULL WHERE message_id=$1`, [msg.id]);
  await tx.query(`UPDATE inbox_conversations SET version=version+1, updated_at=now() WHERE id=$1`, [msg.conversation_id]);
  await inboxEvent(tx, { workspaceId: ch.workspace_id, conversationId: msg.conversation_id, brandId: ch.brand_id, kind: 'message.deleted', data: { message_id: msg.id } });
  return true;
}

async function applyReceipt(db: Queryable, ch: ChannelRow, r: Extract<InboundItem, { type: 'receipt' }>): Promise<number> {
  const conv = await maybeOne<{ id: string }>(db, `SELECT id FROM inbox_conversations WHERE channel_id=$1 AND external_thread_id=$2`, [ch.id, r.threadKey]);
  if (!conv) return 0;
  const target = r.kind;
  const res = await db.query(
    `UPDATE inbox_messages SET delivery_state=$3 WHERE conversation_id=$1 AND direction='outbound' AND deleted_at IS NULL
        AND (provider_created_at <= $2 OR external_id = ANY($4::text[]))
        AND (delivery_state IS NULL OR (CASE delivery_state WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 ELSE 3 END) < $5)`,
    [conv.id, new Date(r.watermark), target, r.externalIds, RANK[target]]);
  return res.rowCount ?? 0;
}
