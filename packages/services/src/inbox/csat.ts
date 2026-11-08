// V3.5 stream B — customer satisfaction (brief §12): optional, only on channels where an admin explicitly enabled it
// and only in private conversations Relay can message (no public comments, no reviews). A request is a normal
// customer-facing send (requestReply: permission, window, send-once), and a response is recorded ONLY when the customer
// answers with a number 1–5 while the request is open (7 days). Silence is never a score. The report shows requests
// actually sent, responses, response rate and the score distribution together.
import { AppError } from '@social-lite/core';
import { getPool, many, maybeOne, one, type Queryable } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { authorizeCtx, brandAllowed, requireAction } from '../tenancy.js';
import { loadChannelFor } from './channels.js';
import { requestReply } from './replies.js';
import { inboxEvent, loadChannelRow, loadConversation } from './shared.js';

export const CSAT_TEXT = 'How did we do? Reply with a number from 1 (poor) to 5 (great).';
const OPEN_DAYS = 7;
/** Channels whose private conversations Relay can message. */
export const CSAT_KINDS = ['facebook_page', 'instagram', 'telegram_bot', 'whatsapp', 'bluesky'] as const;
const SCORE_RE = /^\s*([1-5])\s*(?:\/\s*5)?\s*[.!]?\s*$/;

export const csatToggleSchema = z.object({ enabled: z.boolean() }).strict();

export async function setCsatEnabled(ctx: Ctx, channelId: string, enabled: boolean): Promise<{ enabled: boolean }> {
  const ch = await loadChannelFor(ctx, channelId, 'inbox.manage');
  if (enabled && !(CSAT_KINDS as readonly string[]).includes(ch.kind)) throw new AppError('validation_failed', 'Satisfaction requests are not supported on this channel.');
  await getPool().query(`UPDATE inbox_channels SET settings = settings || jsonb_build_object('csat_enabled', $2::boolean), updated_at=now() WHERE id=$1`, [ch.id, enabled]);
  await audit(getPool(), { workspaceId: ch.workspace_id, brandId: ch.brand_id, actorUserId: ctx.actor.userId, action: enabled ? 'inbox.csat_enabled' : 'inbox.csat_disabled', resourceType: 'inbox_channel', resourceId: ch.id, correlationId: ctx.correlationId });
  return { enabled };
}

export const csatRequestSchema = z.object({ idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/) }).strict();

export interface CsatStateDto { available: boolean; reason: string | null; request: { id: string; state: 'sending' | 'open' | 'answered' | 'expired' | 'not_sent'; score: number | null; requested_at: string; responded_at: string | null } | null }

export async function csatState(ctx: Ctx, conversationId: string): Promise<CsatStateDto> {
  const c = await loadConversation(ctx, conversationId, 'inbox.read');
  const ch = await loadChannelRow(getPool(), c.channel_id);
  const r = await maybeOne<{ id: string; score: number | null; requested_at: Date; responded_at: Date | null; closed_at: Date | null; expires_at: Date; state: string | null }>(getPool(),
    `SELECT q.id, q.score, q.requested_at, q.responded_at, q.closed_at, q.expires_at, a.state FROM inbox_csat_requests q LEFT JOIN inbox_reply_attempts a ON a.id=q.reply_attempt_id
      WHERE q.conversation_id=$1 ORDER BY q.requested_at DESC LIMIT 1`, [conversationId]);
  const enabled = ch?.settings?.csat_enabled === true && (CSAT_KINDS as readonly string[]).includes(ch.kind) && c.kind === 'dm';
  const state = !r ? null : r.responded_at ? 'answered' : r.closed_at || r.state === 'failed' || r.state === 'cancelled' ? (r.state === 'sent' ? 'expired' : 'not_sent') : r.state === 'sent' ? (r.expires_at < new Date() ? 'expired' : 'open') : 'sending';
  return {
    available: enabled && authorizeCtx(ctx, 'inbox.reply', { brandId: c.brand_id }).allowed && state !== 'open' && state !== 'sending',
    reason: !enabled ? 'Not enabled for this channel.' : null,
    request: r ? { id: r.id, state: state as NonNullable<CsatStateDto['request']>['state'], score: r.score, requested_at: r.requested_at.toISOString(), responded_at: r.responded_at?.toISOString() ?? null } : null,
  };
}

export async function requestCsat(ctx: Ctx, conversationId: string, input: z.infer<typeof csatRequestSchema>): Promise<CsatStateDto> {
  const c = await loadConversation(ctx, conversationId, 'inbox.reply');
  const ch = await loadChannelRow(getPool(), c.channel_id);
  if (!ch || ch.settings?.csat_enabled !== true || !(CSAT_KINDS as readonly string[]).includes(ch.kind) || c.kind !== 'dm') throw new AppError('invalid_state', 'Satisfaction requests are not enabled for this channel.');
  const open = await maybeOne(getPool(), `SELECT 1 FROM inbox_csat_requests WHERE conversation_id=$1 AND responded_at IS NULL AND closed_at IS NULL AND expires_at > now()`, [conversationId]);
  if (open) throw new AppError('conflict', 'A satisfaction request is already open for this conversation.');
  // A normal customer-facing send: permission, reply window, collision and send-once rules all apply.
  const r = await requestReply(ctx, conversationId, { mode: 'private_message', body: CSAT_TEXT, base_version: c.version, idempotency_key: input.idempotency_key });
  await getPool().query(`UPDATE inbox_reply_attempts SET purpose='csat' WHERE id=$1`, [r.attempt.id]);
  if (r.created) {
    await getPool().query(`UPDATE inbox_csat_requests SET closed_at=now() WHERE conversation_id=$1 AND responded_at IS NULL AND closed_at IS NULL`, [conversationId]);
    await one(getPool(), `INSERT INTO inbox_csat_requests(workspace_id, brand_id, conversation_id, channel_id, case_id, reply_attempt_id, requested_by, expires_at, is_simulated)
                          VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(days => $8), $9) RETURNING id`,
      [c.workspace_id, c.brand_id, c.id, c.channel_id, c.case_id, r.attempt.id, ctx.actor.userId, OPEN_DAYS, c.is_simulated]);
    await audit(getPool(), { workspaceId: c.workspace_id, brandId: c.brand_id, actorUserId: ctx.actor.userId, action: 'inbox.csat_requested', resourceType: 'inbox_conversation', resourceId: c.id, correlationId: ctx.correlationId });
  }
  return csatState(ctx, conversationId);
}

/** Called by ingestion for every inbound message (inside its transaction). Records only an explicit 1–5 answer. */
export async function recordCsatResponse(tx: Queryable, conversationId: string, messageId: string, text: string, at: Date): Promise<boolean> {
  const m = SCORE_RE.exec(text ?? '');
  if (!m) return false;
  const q = await maybeOne<{ id: string; workspace_id: string; brand_id: string }>(tx,
    `SELECT q.id, q.workspace_id, q.brand_id FROM inbox_csat_requests q JOIN inbox_reply_attempts a ON a.id=q.reply_attempt_id AND a.state='sent'
      WHERE q.conversation_id=$1 AND q.responded_at IS NULL AND q.closed_at IS NULL AND q.expires_at > $2 AND coalesce(a.sent_at, q.requested_at) <= $2
      ORDER BY q.requested_at DESC LIMIT 1 FOR UPDATE OF q`, [conversationId, at]);
  if (!q) return false;
  await tx.query(`UPDATE inbox_csat_requests SET score=$2, responded_at=$3, response_message_id=$4 WHERE id=$1`, [q.id, Number(m[1]), at, messageId]);
  await inboxEvent(tx, { workspaceId: q.workspace_id, conversationId, brandId: q.brand_id, kind: 'csat.answered', data: { score: Number(m[1]) } });
  return true;
}

/** Worker: close expired requests and requests whose send failed (no response is ever inferred). */
export async function sweepCsat(): Promise<number> {
  const r = await getPool().query(`UPDATE inbox_csat_requests q SET closed_at=now() FROM inbox_reply_attempts a
                                    WHERE a.id=q.reply_attempt_id AND q.responded_at IS NULL AND q.closed_at IS NULL AND (q.expires_at <= now() OR a.state IN ('failed','cancelled'))`);
  return r.rowCount ?? 0;
}

export interface CsatReport { window_days: number; definitions: Record<string, string>; sent: number; responses: number; response_rate: number | null; average: number | null; distribution: Record<'1' | '2' | '3' | '4' | '5', number>; awaiting: number }

export async function csatReport(ctx: Ctx, q: { days?: number | string | null; brand_id?: string | null } = {}): Promise<CsatReport> {
  requireAction(ctx, 'inbox.read');
  const days = Math.min(Math.max(Number(q.days) || 30, 1), 365);
  const brands = (await many<{ id: string }>(getPool(), `SELECT id FROM brands WHERE workspace_id=$1`, [ctx.access.workspaceId])).map((b) => b.id)
    .filter((b) => brandAllowed(ctx, b) && authorizeCtx(ctx, 'inbox.read', { brandId: b }).allowed && (!q.brand_id || q.brand_id === b));
  const r = await one<{ sent: number; responses: number; awaiting: number; avg: number | null; s1: number; s2: number; s3: number; s4: number; s5: number }>(getPool(),
    `SELECT count(*) FILTER (WHERE a.state='sent')::int sent, count(q.score)::int responses,
            count(*) FILTER (WHERE a.state='sent' AND q.responded_at IS NULL AND q.closed_at IS NULL AND q.expires_at > now())::int awaiting,
            avg(q.score)::float8 avg, count(*) FILTER (WHERE q.score=1)::int s1, count(*) FILTER (WHERE q.score=2)::int s2, count(*) FILTER (WHERE q.score=3)::int s3,
            count(*) FILTER (WHERE q.score=4)::int s4, count(*) FILTER (WHERE q.score=5)::int s5
       FROM inbox_csat_requests q LEFT JOIN inbox_reply_attempts a ON a.id=q.reply_attempt_id
      WHERE q.workspace_id=$1 AND q.brand_id = ANY($2::uuid[]) AND q.requested_at > now() - make_interval(days => $3)`, [ctx.access.workspaceId, brands, days]);
  return {
    window_days: days,
    definitions: {
      sent: 'Requests the provider confirmed as sent (failed or unconfirmed sends are excluded).',
      responses: 'Customers who answered with a number from 1 to 5 within 7 days. Other replies and silence are not scores.',
      response_rate: 'Responses ÷ sent.',
      average: 'Mean of the responses only.',
    },
    sent: r.sent, responses: r.responses, awaiting: r.awaiting, response_rate: r.sent ? Math.round((r.responses / r.sent) * 1000) / 1000 : null,
    average: r.avg === null ? null : Math.round(r.avg * 100) / 100, distribution: { 1: r.s1, 2: r.s2, 3: r.s3, 4: r.s4, 5: r.s5 },
  };
}
