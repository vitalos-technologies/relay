// Customer replies: send-once with concurrency protection (brief §11, §13; acceptance tests 1, 2, 3, 13).
//  - requestReply: in ONE transaction on the locked conversation — idempotency key (repeat ⇒ same attempt), permission,
//    channel + provider reply rules, and the thread version the agent saw. Any change since (another agent's reply,
//    a pending send, a new customer message) ⇒ 409 with what changed; the agent must review and acknowledge the CURRENT
//    version. A partial unique index allows only one queued/sending attempt per conversation (second agent ⇒ 409).
//  - dispatch (worker, workload class customer_reply): lease → re-check at send time (sender still authorised, channel
//    active, reply window, no outside reply since queuing) → provider call with the EXACT stored text.
//  - outcomes: sent (provider id stored, actual result shown) · failed (provider refused; nothing sent) · retry (refused
//    before acting) · unknown (may have been sent: reconcile through findSent, never resend automatically).
//  - internal notes are a separate table; nothing here reads them.
import { createHash } from 'node:crypto';
import { AppError, notFound } from '@social-lite/core';
import type { ReplyAttemptDto, ReplyRequest, TemplateSend, ThreadChangedDetails } from '@social-lite/core/contracts/v35-inbox';
import { getInboxAdapter } from '@social-lite/providers';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { log } from '../log.js';
import { loadUserAuthz } from '../authz.js';
import { staffAllowed } from '../collab/access.js';
import { ChannelUnavailableError, channelRuntime } from './channels-runtime.js';
import { prepareTemplateSend } from './channels-whatsapp.js';
import { recordActivity } from '../connectors/store.js';
import { getSetting } from '../settings.js';
import { isAutomated } from '../automation/origin.js';
import { onBusinessReply } from './cases.js';
import { attemptDto } from './conversations.js';
import { inboxEvent, loadChannelRow, loadConversation, people, type ConversationRow } from './shared.js';

const LEASE_MS = 90_000;
const MAX_RETRIES = 5;
const RECONCILE_DELAY_MS = 20_000;

export const replySchema = z.object({
  mode: z.enum(['public_reply', 'private_message']),
  body: z.string().trim().min(1).max(2000),
  base_version: z.number().int().positive(),
  idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
  acknowledge_version: z.number().int().positive().nullable().optional(),
  // Stream B (WhatsApp): approved template + the charge acknowledgement shown before sending.
  template: z.object({ name: z.string().regex(/^[a-z0-9_]{1,512}$/), language: z.string().regex(/^[A-Za-z_]{2,15}$/), params: z.array(z.string().trim().min(1).max(1000)).max(20).default([]) }).strict().nullable().optional(),
  acknowledge_charge: z.boolean().optional(),
}).strict();

type AttemptRow = Parameters<typeof attemptDto>[0] & { workspace_id: string; brand_id: string; channel_id: string; base_version: number; idempotency_key: string; body_sha256: string; reply_to_external_id: string | null; next_attempt_at: Date; lease_owner: string | null; reconcile_after: Date | null; automated: boolean;
  template: TemplateSend | null; charge: Record<string, unknown> | null; target_meta: Record<string, unknown> | null; purpose: 'reply' | 'csat' };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function features(): Promise<string[]> {
  return (await getSetting('META_HUMAN_AGENT_APPROVED')) === 'true' ? ['human_agent'] : [];
}

async function dto(db: Queryable, a: AttemptRow): Promise<ReplyAttemptDto> {
  return attemptDto(a, await people(db, [a.created_by]));
}

/** What changed since `base` (other agents' replies, pending sends, messages from the customer or from outside Relay). */
async function changesSince(db: Queryable, conv: ConversationRow, base: number, me: string): Promise<ThreadChangedDetails['changes']> {
  const out: ThreadChangedDetails['changes'] = [];
  const atts = await many<{ created_by: string | null; created_at: Date; mode: 'public_reply' | 'private_message'; state: ReplyAttemptDto['state'] }>(db,
    `SELECT created_by, created_at, mode, state FROM inbox_reply_attempts
      WHERE conversation_id=$1 AND (state IN ('queued','sending','unknown') OR (state='sent' AND base_version >= $2)) ORDER BY created_at DESC LIMIT 5`, [conv.id, base]);
  const ppl = await people(db, atts.map((p) => p.created_by));
  for (const p of atts) out.push({ kind: p.state === 'sent' ? 'reply' : 'pending_reply', by: p.created_by === me ? 'You' : (p.created_by && (ppl.get(p.created_by)?.name ?? ppl.get(p.created_by)?.email)) || null, at: p.created_at.toISOString(), mode: p.mode, state: p.state });
  const msgs = await many<{ provider_created_at: Date; direction: string }>(db,
    `SELECT provider_created_at, direction FROM inbox_messages WHERE conversation_id=$1 AND reply_attempt_id IS NULL AND conv_version > $2 ORDER BY provider_created_at DESC LIMIT 5`, [conv.id, base]);
  for (const m of msgs) out.push({ kind: m.direction === 'inbound' ? 'customer_message' : 'reply', by: m.direction === 'inbound' ? 'Customer' : 'Outside Relay', at: m.provider_created_at.toISOString() });
  return out;
}

export async function requestReply(ctx: Ctx, conversationId: string, input: ReplyRequest): Promise<{ attempt: ReplyAttemptDto; created: boolean }> {
  const res = await withTx(async (tx) => {
    const conv = await loadConversation(ctx, conversationId, 'inbox.reply', tx, true);
    const prior = await maybeOne<AttemptRow>(tx, `SELECT * FROM inbox_reply_attempts WHERE workspace_id=$1 AND idempotency_key=$2`, [ctx.access.workspaceId, input.idempotency_key]);
    if (prior) {
      if (prior.conversation_id !== conversationId || prior.body_sha256 !== sha(input.body) || prior.mode !== input.mode) throw new AppError('idempotency_conflict', 'This send key was already used for a different reply.');
      return { attempt: prior, created: false };
    }
    const ch = await loadChannelRow(tx, conv.channel_id);
    const adapter = ch ? getInboxAdapter(ch.kind) : null;
    if (!ch || !adapter || ch.disconnected_at) throw new AppError('invalid_state', 'This channel is no longer connected.', undefined, { reason: 'channel_unavailable' });
    if (ch.status !== 'active') throw new AppError('invalid_state', ch.status === 'paused' ? 'This channel is paused.' : (ch.status_detail ?? 'This channel needs attention.'), undefined, { reason: 'channel_unavailable' });
    if (conv.status === 'spam') throw new AppError('invalid_state', 'Marked as spam. Move it out of spam to reply.', undefined, { reason: 'conversation_closed' });
    const rules = adapter.replyRules({ kind: conv.kind, mode: input.mode, now: new Date(), lastInboundAt: conv.last_inbound_at, firstInboundAt: conv.first_inbound_at, privateReplyUsed: conv.private_reply_used, features: await features() });
    // Stream B: a WhatsApp template is the documented way to write outside the 24 h window; the charge must be acknowledged.
    const tpl = input.template ? prepareTemplateSend(ch, input.template, rules.allowed) : null;
    if (!rules.allowed && !tpl) throw new AppError('invalid_state', rules.message, undefined, { reason: rules.code });
    if (tpl?.charge.billable && !input.acknowledge_charge) throw new AppError('invalid_state', `${tpl.charge.note} Confirm the charge to send.`, undefined, { reason: 'charge_ack_required', charge: tpl.charge });
    // Collision / thread-changed check on the locked row.
    if (input.base_version !== conv.version && input.acknowledge_version !== conv.version) {
      const details: ThreadChangedDetails = { current_version: conv.version, changes: await changesSince(tx, conv, input.base_version, ctx.actor.userId) };
      const otherReply = details.changes.some((c) => c.kind !== 'customer_message');
      throw new AppError('conflict', otherReply ? 'Someone already replied or is sending a reply. Review the thread before sending.' : 'New messages arrived. Review them before sending.', undefined, { reason: otherReply ? 'reply_collision' : 'thread_changed', ...details });
    }
    const inflight = await maybeOne<{ created_by: string | null }>(tx, `SELECT created_by FROM inbox_reply_attempts WHERE conversation_id=$1 AND state IN ('queued','sending')`, [conversationId]);
    if (inflight) {
      throw new AppError('conflict', 'Another reply is being sent on this conversation. Wait for its result.', undefined, { reason: 'reply_collision', current_version: conv.version, changes: await changesSince(tx, conv, input.base_version, ctx.actor.userId) });
    }
    // Stream B: the message being answered (latest customer message) + its provider refs, snapshotted with the attempt.
    const last = await maybeOne<{ external_id: string; meta: Record<string, unknown> }>(tx, `SELECT external_id, meta FROM inbox_messages WHERE conversation_id=$1 AND direction='inbound' AND deleted_at IS NULL AND external_id IS NOT NULL ORDER BY provider_created_at DESC LIMIT 1`, [conversationId]);
    const replyTo = last?.external_id ?? null;
    const a = await one<AttemptRow>(tx,
      `INSERT INTO inbox_reply_attempts(workspace_id, brand_id, conversation_id, channel_id, mode, body, body_sha256, base_version, idempotency_key, reply_to_external_id, is_simulated, created_by, automated, template, charge, target_meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [ctx.access.workspaceId, conv.brand_id, conversationId, ch.id, input.mode, tpl ? tpl.rendered : input.body, sha(input.body), conv.version, input.idempotency_key, replyTo, ch.is_simulated, ctx.actor.userId, isAutomated(),
        tpl ? JSON.stringify(tpl.template) : null, tpl ? JSON.stringify(tpl.charge) : null, last ? JSON.stringify(last.meta ?? {}) : null]);
    await tx.query(`UPDATE inbox_conversations SET version=version+1, updated_at=now(), private_reply_used = private_reply_used OR ($2 = 'private_message' AND kind='comment') WHERE id=$1`, [conversationId, input.mode]);
    await tx.query(`DELETE FROM inbox_drafts WHERE conversation_id=$1 AND user_id=$2`, [conversationId, ctx.actor.userId]);
    await inboxEvent(tx, { workspaceId: conv.workspace_id, conversationId, brandId: conv.brand_id, kind: 'reply.queued', actorId: ctx.actor.userId, data: { attempt_id: a.id, mode: input.mode } });
    await writeOutbox(tx, { workspaceId: conv.workspace_id, aggregateType: 'inbox_reply_attempt', aggregateId: a.id, eventType: 'inbox.reply_requested', payload: { conversationId } });
    await audit(tx, { workspaceId: conv.workspace_id, brandId: conv.brand_id, actorUserId: ctx.actor.userId, action: 'inbox.reply_requested', resourceType: 'inbox_conversation', resourceId: conversationId, diff: { attempt_id: a.id, mode: input.mode, length: input.body.length }, correlationId: ctx.correlationId });
    return { attempt: a, created: true };
  }).catch((err: unknown) => {
    // Two agents racing past the version check: the partial unique index refuses the second insert.
    if ((err as { code?: string; constraint?: string }).code === '23505' && (err as { constraint?: string }).constraint === 'inbox_reply_inflight_uniq') {
      throw new AppError('conflict', 'Another reply is being sent on this conversation. Wait for its result.', undefined, { reason: 'reply_collision' });
    }
    throw err;
  });
  return { attempt: await dto(getPool(), res.attempt), created: res.created };
}

export async function listAttempts(ctx: Ctx, conversationId: string): Promise<{ items: ReplyAttemptDto[] }> {
  await loadConversation(ctx, conversationId, 'inbox.read');
  const rows = await many<AttemptRow>(getPool(), `SELECT * FROM inbox_reply_attempts WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 50`, [conversationId]);
  const ppl = await people(getPool(), rows.map((r) => r.created_by));
  return { items: rows.map((r) => attemptDto(r, ppl)) };
}

export async function getAttempt(ctx: Ctx, id: string): Promise<ReplyAttemptDto> {
  const a = await maybeOne<AttemptRow>(getPool(), `SELECT * FROM inbox_reply_attempts WHERE id=$1 AND workspace_id=$2`, [id, ctx.access.workspaceId]);
  if (!a) throw notFound('Reply');
  await loadConversation(ctx, a.conversation_id, 'inbox.read');
  return dto(getPool(), a);
}

// ------------------------------------------------------------------ worker
async function settle(db: Queryable, a: AttemptRow, state: 'failed' | 'cancelled', code: string, message: string, providerResult: Record<string, unknown> | null = null): Promise<void> {
  await withTx(async (tx) => {
    await tx.query(`UPDATE inbox_reply_attempts SET state=$2, error_code=$3, error_message=$4, provider_result=coalesce($5, provider_result), lease_owner=NULL, lease_expires_at=NULL, finished_at=now(), updated_at=now() WHERE id=$1`,
      [a.id, state, code, message.slice(0, 300), providerResult ? JSON.stringify(providerResult) : null]);
    // A private reply that was refused was not used.
    if (a.mode === 'private_message') await tx.query(`UPDATE inbox_conversations SET private_reply_used=false WHERE id=$1 AND kind='comment' AND NOT EXISTS (SELECT 1 FROM inbox_reply_attempts WHERE conversation_id=$1 AND mode='private_message' AND state IN ('sent','unknown','queued','sending') AND id <> $2)`, [a.conversation_id, a.id]);
    await tx.query(`UPDATE inbox_conversations SET version=version+1, updated_at=now() WHERE id=$1`, [a.conversation_id]);
    await inboxEvent(tx, { workspaceId: a.workspace_id, conversationId: a.conversation_id, brandId: a.brand_id, kind: `reply.${state}`, data: { attempt_id: a.id, code } });
    await writeOutbox(tx, { workspaceId: a.workspace_id, aggregateType: 'inbox_reply_attempt', aggregateId: a.id, eventType: 'inbox.reply_finished', payload: { state } });
  });
}

async function markSent(a: AttemptRow, externalId: string, detail: Record<string, unknown>, reconciled = false): Promise<void> {
  await withTx(async (tx) => {
    const now = new Date();
    const upd = await tx.query(`UPDATE inbox_reply_attempts SET state='sent', provider_message_id=$2, provider_result=$3, sent_at=$4, lease_owner=NULL, lease_expires_at=NULL, finished_at=now(), reconciled_at=CASE WHEN $5 THEN now() ELSE reconciled_at END, updated_at=now(), error_code=NULL, error_message=NULL
                                 WHERE id=$1 AND state IN ('sending','unknown')`, [a.id, externalId, JSON.stringify({ external_id: externalId, ...detail, ...(reconciled ? { reconciled: true } : {}) }), now, reconciled]);
    if (!upd.rowCount) return;
    // The provider echo may already have created the message row: attach it instead of duplicating.
    await tx.query(
      `INSERT INTO inbox_messages(workspace_id, conversation_id, channel_id, direction, external_id, parent_external_id, author_user_id, body, provider_created_at, reply_attempt_id, delivery_state, is_simulated, automated)
       VALUES ($1,$2,$3,'outbound',$4,$5,$6,$7,$8,$9,'sent',$10,$11)
       ON CONFLICT (channel_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET reply_attempt_id=EXCLUDED.reply_attempt_id, author_user_id=EXCLUDED.author_user_id`,
      [a.workspace_id, a.conversation_id, a.channel_id, externalId, a.reply_to_external_id, a.created_by, a.body, now, a.id, a.is_simulated, a.automated]);
    const conv = await one<{ case_id: string | null; status: string; version: number }>(tx,
      `UPDATE inbox_conversations SET version=version+1, last_outbound_at=$2, last_message_at=greatest(last_message_at, $2), unanswered_since=NULL, preview=$3, updated_at=now()
        WHERE id=$1 RETURNING case_id, status, version`, [a.conversation_id, now, a.body.replace(/\s+/g, ' ').slice(0, 160)]);
    await tx.query(`UPDATE inbox_messages SET conv_version=$2 WHERE channel_id=$3 AND external_id=$1`, [externalId, conv.version, a.channel_id]);
    if (conv.case_id) await onBusinessReply(tx, conv.case_id, now, a.automated);
    await inboxEvent(tx, { workspaceId: a.workspace_id, conversationId: a.conversation_id, brandId: a.brand_id, kind: 'reply.sent', data: { attempt_id: a.id, reconciled } });
    await writeOutbox(tx, { workspaceId: a.workspace_id, aggregateType: 'inbox_reply_attempt', aggregateId: a.id, eventType: 'inbox.reply_finished', payload: { state: 'sent' } });
  });
}

export type AutomatedReplyGuard = (a: { workspaceId: string; idempotencyKey: string; brandId: string; conversationId: string }) => Promise<{ allowed: true } | { allowed: false; code: string; message: string }>;
let automatedGuard: AutomatedReplyGuard | null = null;
/** Stream E registers the dispatch-time policy check for automated replies (automation/guard.ts). */
export function registerAutomatedReplyGuard(g: AutomatedReplyGuard | null): void { automatedGuard = g; }

/** Process one reply attempt (fast path from the 'inbox-reply' queue and the recovery sweep). */
export async function dispatchReply(attemptId: string, workerId: string): Promise<ReplyAttemptDto['state'] | 'skipped'> {
  const db = getPool();
  const a = await maybeOne<AttemptRow>(db,
    `UPDATE inbox_reply_attempts SET state='sending', attempts=attempts+1, lease_owner=$2, lease_expires_at=now() + make_interval(secs => $3), updated_at=now()
      WHERE id=$1 AND state='queued' AND next_attempt_at <= now() RETURNING *`, [attemptId, workerId, LEASE_MS / 1000]);
  if (!a) return 'skipped';
  const conv = await maybeOne<ConversationRow>(db, `SELECT * FROM inbox_conversations WHERE id=$1`, [a.conversation_id]);
  const ch = conv ? await loadChannelRow(db, conv.channel_id) : null;
  const adapter = ch ? getInboxAdapter(ch.kind) : null;
  if (!conv || !ch || !adapter || ch.disconnected_at || (!ch.connection_id && !ch.integration_id)) { await settle(db, a, 'cancelled', 'channel_unavailable', 'The channel was removed before sending. Nothing was sent.'); return 'cancelled'; }
  // V3.5 automation (stream E): automated attempts are re-checked against their automation policy (active, unexpired,
  // not stopped, workspace emergency stop off, policy owner still allowed). No guard registered ⇒ refused.
  if (a.automated) {
    const g = automatedGuard ? await automatedGuard({ workspaceId: a.workspace_id, idempotencyKey: a.idempotency_key, brandId: a.brand_id, conversationId: a.conversation_id }) : { allowed: false as const, code: 'automation_unavailable', message: 'Automation is not available. Nothing was sent.' };
    if (!g.allowed) { await settle(db, a, 'cancelled', g.code, g.message); return 'cancelled'; }
  }
  // Re-check at send time: the sender still has inbox.reply on the brand (membership revocation blocks the send).
  if (a.created_by && !a.automated) {
    const s = await loadUserAuthz(a.created_by, a.workspace_id, null, db);
    if (s.subject.status !== 'active' || !staffAllowed(s, 'inbox.reply', a.brand_id)) { await settle(db, a, 'cancelled', 'sender_lost_access', 'The sender no longer has permission to reply. Nothing was sent.'); return 'cancelled'; }
  }
  if (ch.status !== 'active') { await settle(db, a, 'failed', 'channel_unavailable', ch.status === 'paused' ? 'The channel is paused. Nothing was sent.' : 'The channel needs attention. Nothing was sent.'); return 'failed'; }
  if (conv.status === 'spam') { await settle(db, a, 'cancelled', 'conversation_closed', 'The conversation was marked as spam. Nothing was sent.'); return 'cancelled'; }
  const rules = adapter.replyRules({ kind: conv.kind, mode: a.mode, now: new Date(), lastInboundAt: conv.last_inbound_at, firstInboundAt: conv.first_inbound_at, privateReplyUsed: false, features: await features() });
  if (!rules.allowed && !a.template) { await settle(db, a, 'failed', rules.code, `${rules.message} Nothing was sent.`); return 'failed'; }
  const outside = await maybeOne(db, `SELECT 1 FROM inbox_messages WHERE conversation_id=$1 AND direction='outbound' AND reply_attempt_id IS NULL AND received_at > $2`, [conv.id, a.created_at]);
  if (outside) { await settle(db, a, 'cancelled', 'reply_collision', 'A reply was sent from outside Relay after this one was queued. Nothing was sent; review the thread.'); return 'cancelled'; }

  let rt;
  try {
    rt = await channelRuntime(ch, db); // live channels always get the live transport; simulated ones the simulated API
  } catch (err) {
    if (err instanceof ChannelUnavailableError && err.retryable && a.attempts < MAX_RETRIES) {
      await db.query(`UPDATE inbox_reply_attempts SET state='queued', next_attempt_at=now() + interval '60 seconds', lease_owner=NULL, lease_expires_at=NULL, error_code='credentials_unavailable', error_message=$2, updated_at=now() WHERE id=$1`, [a.id, err.message]);
      return 'queued';
    }
    await settle(db, a, 'failed', 'reconnect_required', err instanceof ChannelUnavailableError ? `${err.message} Nothing was sent.` : 'The account could not be used. Nothing was sent.');
    return 'failed';
  }
  const target = { conversationKind: conv.kind, threadKey: conv.external_thread_id, replyToExternalId: a.reply_to_external_id, contactExternalId: null, replyToMeta: a.target_meta };
  const r = await adapter.sendReply(rt.ctx, rt.creds, rt.conn, { mode: a.mode, target, text: a.body, tag: rules.allowed ? rules.tag : undefined, attemptId: a.id, template: a.template });
  await recordActivity(db, { workspaceId: a.workspace_id, channelId: ch.id, kind: 'sync', outcome: r.kind === 'sent' ? 'ok' : r.kind === 'retry' ? 'retry' : 'error', code: r.kind === 'sent' ? 'reply_sent' : r.code, message: r.kind === 'sent' ? null : r.message });
  switch (r.kind) {
    case 'sent':
      await markSent(a, r.externalId, r.detail);
      return 'sent';
    case 'retry':
      if (a.attempts < MAX_RETRIES) {
        const wait = Math.max(r.retryAfterMs ?? 0, 15_000 * 2 ** (a.attempts - 1));
        await db.query(`UPDATE inbox_reply_attempts SET state='queued', next_attempt_at=now() + make_interval(secs => $2), lease_owner=NULL, lease_expires_at=NULL, error_code=$3, error_message=$4, updated_at=now() WHERE id=$1`,
          [a.id, Math.ceil(Math.min(wait, 15 * 60_000) / 1000), r.code, r.message]);
        return 'queued';
      }
      await settle(db, a, 'failed', r.code, `${r.message} Gave up after ${a.attempts} attempts. Nothing was sent.`, { code: r.code });
      return 'failed';
    case 'rejected':
      await settle(db, a, 'failed', r.code, r.message, { code: r.code, message: r.message });
      if (r.reconnect && ch.connection_id) {
        const { markReconnectRequired } = await import('../connections/index.js');
        await markReconnectRequired(ch.connection_id, r.message, 'inbox').catch(() => undefined);
      } else if (r.reconnect && ch.integration_id) {
        await db.query(`UPDATE integration_connections SET status='reconnect_required', health_message=$2, updated_at=now() WHERE id=$1`, [ch.integration_id, r.message.slice(0, 300)]).catch(() => undefined);
      }
      return 'failed';
    case 'unknown':
      await db.query(`UPDATE inbox_reply_attempts SET state='unknown', reconcile_after=now() + make_interval(secs => $2), lease_owner=NULL, lease_expires_at=NULL, error_code=$3, error_message=$4, updated_at=now() WHERE id=$1`,
        [a.id, RECONCILE_DELAY_MS / 1000, r.code, r.message]);
      await inboxEvent(db, { workspaceId: a.workspace_id, conversationId: a.conversation_id, brandId: a.brand_id, kind: 'reply.unknown', data: { attempt_id: a.id } });
      return 'unknown';
  }
}

/** Worker: look for the provider record of 'unknown' sends. Found ⇒ sent (with provider evidence). Never resends. */
export async function reconcileUnknownReplies(limit = 20): Promise<{ resolved: number; pending: number }> {
  const db = getPool();
  const rows = await many<AttemptRow>(db, `SELECT * FROM inbox_reply_attempts WHERE state='unknown' AND reconciled_at IS NULL AND reconcile_after <= now() ORDER BY reconcile_after LIMIT $1`, [limit]);
  let resolved = 0;
  for (const a of rows) {
    const conv = await maybeOne<ConversationRow>(db, `SELECT * FROM inbox_conversations WHERE id=$1`, [a.conversation_id]);
    const ch = conv ? await loadChannelRow(db, conv.channel_id) : null;
    const adapter = ch ? getInboxAdapter(ch.kind) : null;
    let found: Awaited<ReturnType<NonNullable<typeof adapter>['findSent']>> = { found: false };
    if (conv && ch && (ch.connection_id || ch.integration_id) && adapter) {
      try {
        const rt = await channelRuntime(ch, db);
        found = await adapter.findSent(rt.ctx, rt.creds, rt.conn, { mode: a.mode, target: { conversationKind: conv.kind, threadKey: conv.external_thread_id, replyToExternalId: a.reply_to_external_id, contactExternalId: null, replyToMeta: a.target_meta }, text: a.body, since: a.created_at });
      } catch (err) { log.warn('inbox_reconcile_failed', { attemptId: a.id, err: { name: (err as Error).name } }); }
    }
    if (found.found === true) { await markSent(a, found.externalId, {}, true); resolved++; continue; }
    // After ~10 minutes of checks, stop polling and leave it for a person (shown as "Not confirmed").
    const giveUp = Date.now() - a.created_at.getTime() > 10 * 60_000 || found.found === 'ambiguous';
    await db.query(`UPDATE inbox_reply_attempts SET reconcile_after=now() + interval '60 seconds', reconciled_at=CASE WHEN $2 THEN now() ELSE NULL END, updated_at=now() WHERE id=$1`, [a.id, giveUp]);
  }
  return { resolved, pending: rows.length - resolved };
}

/** Worker sweep: expired 'sending' leases ⇒ unknown (the request may have reached the provider); due queued ids. */
export async function sweepReplies(): Promise<{ expired: number; due: string[] }> {
  const db = getPool();
  const ex = await db.query(`UPDATE inbox_reply_attempts SET state='unknown', reconcile_after=now(), lease_owner=NULL, lease_expires_at=NULL, error_code='lease_expired',
                              error_message='The worker stopped while sending. Checking whether the reply arrived.', updated_at=now() WHERE state='sending' AND lease_expires_at < now()`);
  const due = await many<{ id: string }>(db, `SELECT id FROM inbox_reply_attempts WHERE state='queued' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT 50`);
  return { expired: ex.rowCount ?? 0, due: due.map((d) => d.id) };
}

export const resolveUnknownSchema = z.object({ outcome: z.enum(['sent', 'not_sent']) }).strict();

/** A person settles an unconfirmed send after checking the provider: mark it sent, or not sent (then they may resend). */
export async function resolveUnknownReply(ctx: Ctx, attemptId: string, outcome: 'sent' | 'not_sent'): Promise<ReplyAttemptDto> {
  const a = await maybeOne<AttemptRow>(getPool(), `SELECT * FROM inbox_reply_attempts WHERE id=$1 AND workspace_id=$2`, [attemptId, ctx.access.workspaceId]);
  if (!a) throw notFound('Reply');
  await loadConversation(ctx, a.conversation_id, 'inbox.reply');
  if (a.state !== 'unknown') throw new AppError('invalid_state', 'Only unconfirmed replies can be settled.');
  if (outcome === 'sent') {
    await withTx(async (tx) => {
      await tx.query(`UPDATE inbox_reply_attempts SET state='sent', resolved_by=$2, sent_at=coalesce(sent_at, created_at), provider_result=coalesce(provider_result, '{}'::jsonb) || '{"confirmed_by_person":true}'::jsonb, finished_at=now(), updated_at=now() WHERE id=$1 AND state='unknown'`, [a.id, ctx.actor.userId]);
      await tx.query(`INSERT INTO inbox_messages(workspace_id, conversation_id, channel_id, direction, author_user_id, body, provider_created_at, reply_attempt_id, is_simulated) VALUES ($1,$2,$3,'outbound',$4,$5,$6,$7,$8)`,
        [a.workspace_id, a.conversation_id, a.channel_id, a.created_by, a.body, a.created_at, a.id, a.is_simulated]);
      await tx.query(`UPDATE inbox_conversations SET version=version+1, unanswered_since=NULL, last_outbound_at=greatest(coalesce(last_outbound_at, $2), $2), updated_at=now() WHERE id=$1`, [a.conversation_id, a.created_at]);
      await audit(tx, { workspaceId: a.workspace_id, brandId: a.brand_id, actorUserId: ctx.actor.userId, action: 'inbox.reply_confirmed_by_person', resourceType: 'inbox_conversation', resourceId: a.conversation_id, diff: { attempt_id: a.id }, correlationId: ctx.correlationId });
    });
  } else {
    await settle(getPool(), a, 'failed', 'not_sent_confirmed', 'Checked by a person: not sent.');
    await audit(getPool(), { workspaceId: a.workspace_id, brandId: a.brand_id, actorUserId: ctx.actor.userId, action: 'inbox.reply_marked_not_sent', resourceType: 'inbox_conversation', resourceId: a.conversation_id, diff: { attempt_id: a.id }, correlationId: ctx.correlationId });
  }
  return getAttempt(ctx, attemptId);
}

/**
 * Stream B: provider evidence for an Unknown send that arrived by webhook (WhatsApp status carrying Relay's callback
 * marker `relay:<attempt id>`). Only an attempt still Unknown on the same channel is confirmed; never a resend.
 */
export async function confirmAttemptFromProvider(attemptId: string, channelId: string, externalId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId)) return false;
  const a = await maybeOne<AttemptRow>(getPool(), `SELECT * FROM inbox_reply_attempts WHERE id=$1 AND channel_id=$2 AND state='unknown'`, [attemptId, channelId]);
  if (!a) return false;
  await markSent(a, externalId, { confirmed_by: 'provider_status' }, true);
  return true;
}
