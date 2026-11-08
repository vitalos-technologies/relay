// Inbox shared rows, access helpers and the content-free event writer.
// Authorization: every read needs inbox.read on the conversation's brand; replies inbox.reply; assignment inbox.assign;
// channel setup inbox.manage. Platform operators get nothing implicitly (no inbox access without a workspace grant).
import { notFound, type Permission } from '@social-lite/core';
import type { ChannelKind, ConversationKind, ConversationStatus, PersonRef, Priority } from '@social-lite/core/contracts/v35-inbox';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { assertUuid, authorizeCtx, brandAllowed, requireAction } from '../tenancy.js';

export interface ChannelRow {
  id: string; workspace_id: string; brand_id: string; kind: ChannelKind; connection_id: string | null; integration_id: string | null;
  external_account_id: string; display_name: string; is_simulated: boolean; status: 'active' | 'needs_permission' | 'paused' | 'disconnected' | 'error';
  status_detail: string | null; missing_permissions: string[]; enabled_types: ConversationKind[]; last_inbound_at: Date | null; last_sync_at: Date | null;
  created_by: string | null; created_at: Date; updated_at: Date; disconnected_at: Date | null;
}

export interface ConversationRow {
  id: string; workspace_id: string; brand_id: string; channel_id: string; kind: ConversationKind; visibility: 'private' | 'public';
  external_thread_id: string; contact_id: string | null; subject: string | null; preview: string; status: ConversationStatus; priority: Priority;
  language: string | null; labels: string[]; assignee_id: string | null; team_id: string | null; snoozed_until: Date | null; version: number;
  first_inbound_at: Date | null; last_message_at: Date; last_inbound_at: Date | null; last_outbound_at: Date | null; unanswered_since: Date | null;
  private_reply_used: boolean; related_external_post_id: string | null; related_post_id: string | null; case_id: string | null; is_simulated: boolean;
  created_at: Date; updated_at: Date; resolved_at: Date | null;
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Load a conversation the caller may access (`perm` on its brand). Missing/foreign/unauthorized ⇒ not_found. */
export async function loadConversation(ctx: Ctx, id: string, perm: Permission = 'inbox.read', db: Queryable = getPool(), forUpdate = false): Promise<ConversationRow> {
  assertUuid(id, 'Conversation');
  const r = await maybeOne<ConversationRow>(db, `SELECT * FROM inbox_conversations WHERE id=$1 AND workspace_id=$2${forUpdate ? ' FOR UPDATE' : ''}`, [id, ctx.access.workspaceId]);
  if (!r || !brandAllowed(ctx, r.brand_id) || !authorizeCtx(ctx, 'inbox.read', { brandId: r.brand_id }).allowed) throw notFound('Conversation');
  requireAction(ctx, perm, { brandId: r.brand_id });
  return r;
}

export async function loadChannelRow(db: Queryable, id: string): Promise<ChannelRow | null> {
  return maybeOne<ChannelRow>(db, `SELECT * FROM inbox_channels WHERE id=$1`, [id]);
}

/** Brands on which the caller holds inbox.read (null = all brands of the workspace). */
export function inboxBrands(ctx: Ctx, brandIds: string[]): string[] {
  return brandIds.filter((b) => brandAllowed(ctx, b) && authorizeCtx(ctx, 'inbox.read', { brandId: b }).allowed);
}

export async function people(db: Queryable, ids: Array<string | null | undefined>): Promise<Map<string, PersonRef>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return new Map();
  const rows = await many<{ id: string; name: string | null; email: string }>(db, `SELECT id, name, email FROM users WHERE id = ANY($1::uuid[])`, [uniq]);
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, email: r.email }]));
}

/** Content-free activity event (also the realtime feed). Never put message text here. */
export async function inboxEvent(db: Queryable, e: { workspaceId: string; conversationId: string | null; brandId?: string | null; kind: string; actorId?: string | null; data?: Record<string, unknown> }): Promise<void> {
  await db.query(`INSERT INTO inbox_events(workspace_id, conversation_id, brand_id, kind, actor_id, data) VALUES ($1,$2,$3,$4,$5,$6)`,
    [e.workspaceId, e.conversationId, e.brandId ?? null, e.kind, e.actorId ?? null, JSON.stringify(e.data ?? {})]);
}

export const clipPreview = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
