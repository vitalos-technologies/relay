// Classification of inbound customer messages, persisted per message (signals only, never text). Runs in the
// 'inbox-events' consumer before any automation rule (classification + routing come before automatic replies).
import type { ClassificationDto } from '@social-lite/core/contracts/v35-ai';
import { getPool, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { loadConversation } from '../inbox/shared.js';
import { classifyText } from './classify.js';

interface Row { conversation_id: string; message_id: string; category: ClassificationDto['category']; sentiment: ClassificationDto['sentiment']; language: string | null; urgency: ClassificationDto['urgency']; signals: string[]; injection_suspected: boolean; uncertain: boolean; method: 'rules' | 'model'; created_at: Date }

const dto = (r: Row): ClassificationDto => ({ ...r, created_at: r.created_at.toISOString() });

/** Idempotent: one 'rules' classification per message. Returns null when the message is gone (deleted at the provider). */
export async function classifyMessage(messageId: string, db: Queryable = getPool()): Promise<ClassificationDto | null> {
  const existing = await maybeOne<Row>(db, `SELECT * FROM ai_classifications WHERE message_id=$1 AND method='rules'`, [messageId]);
  if (existing) return dto(existing);
  const m = await maybeOne<{ workspace_id: string; conversation_id: string; body: string | null; direction: string }>(db,
    `SELECT workspace_id, conversation_id, body, direction FROM inbox_messages WHERE id=$1`, [messageId]);
  if (!m || m.direction !== 'inbound' || m.body === null) return null;
  const c = classifyText(m.body);
  const r = await maybeOne<Row>(db,
    `INSERT INTO ai_classifications(workspace_id, conversation_id, message_id, category, sentiment, language, urgency, signals, injection_suspected, uncertain, method)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'rules') ON CONFLICT (message_id, method) DO NOTHING RETURNING *`,
    [m.workspace_id, m.conversation_id, messageId, c.category, c.sentiment, c.language, c.urgency, c.signals, c.injection_suspected, c.uncertain]);
  return dto(r ?? (await maybeOne<Row>(db, `SELECT * FROM ai_classifications WHERE message_id=$1 AND method='rules'`, [messageId]))!);
}

/** Latest classification of a conversation (inbox.read). */
export async function conversationClassification(ctx: Ctx, conversationId: string): Promise<ClassificationDto | null> {
  await loadConversation(ctx, conversationId, 'inbox.read');
  const r = await maybeOne<Row>(getPool(), `SELECT * FROM ai_classifications WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1`, [conversationId]);
  return r ? dto(r) : null;
}
