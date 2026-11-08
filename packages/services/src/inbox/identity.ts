// V3.5 stream B — identity linking (brief §5, §19): provider identities (inbox_contacts) stay separate from Relay's
// internal customers (inbox_customers). A link is created ONLY by an explicit action of a person with cases.manage —
// never by matching names or handles — and is reversible: unlinking keeps the history row (who, when, why).
// Customer history shown is limited to conversations on brands the viewer can read.
import { AppError, notFound } from '@social-lite/core';
import type { ChannelKind, PersonRef } from '@social-lite/core/contracts/v35-inbox';
import { getPool, many, maybeOne, one, withTx } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { authorizeCtx, brandAllowed, requireAction } from '../tenancy.js';
import { loadConversation, people } from './shared.js';

export interface CustomerProfileDto {
  contact: { id: string; name: string | null; handle: string | null; channel: { kind: ChannelKind; display_name: string }; first_seen_at: string } | null;
  customer: { id: string; name: string; brand_id: string | null } | null;
  identities: Array<{ contact_id: string; name: string | null; handle: string | null; channel_kind: ChannelKind; channel_name: string; linked_at: string; linked_by: PersonRef | null; method: string }>;
  conversations: Array<{ id: string; channel_kind: ChannelKind; kind: string; preview: string; status: string; last_message_at: string }>;
  history: Array<{ action: 'linked' | 'unlinked'; at: string; by: PersonRef | null; reason: string | null; customer_name: string }>;
  can_link: boolean;
}

async function readableBrands(ctx: Ctx): Promise<string[]> {
  return (await many<{ id: string }>(getPool(), `SELECT id FROM brands WHERE workspace_id=$1`, [ctx.access.workspaceId])).map((b) => b.id)
    .filter((b) => brandAllowed(ctx, b) && authorizeCtx(ctx, 'inbox.read', { brandId: b }).allowed);
}

export async function customerProfile(ctx: Ctx, conversationId: string): Promise<CustomerProfileDto> {
  const conv = await loadConversation(ctx, conversationId, 'inbox.read');
  const canLink = authorizeCtx(ctx, 'cases.manage', { brandId: conv.brand_id }).allowed;
  if (!conv.contact_id) return { contact: null, customer: null, identities: [], conversations: [], history: [], can_link: false };
  const db = getPool();
  const ct = await one<{ id: string; display_name: string | null; handle: string | null; customer_id: string | null; first_seen_at: Date; kind: ChannelKind; ch_name: string }>(db,
    `SELECT ct.id, ct.display_name, ct.handle, ct.customer_id, ct.first_seen_at, ch.kind, ch.display_name AS ch_name FROM inbox_contacts ct JOIN inbox_channels ch ON ch.id=ct.channel_id WHERE ct.id=$1`, [conv.contact_id]);
  const brands = await readableBrands(ctx);
  const cust = ct.customer_id ? await maybeOne<{ id: string; display_name: string; brand_id: string | null }>(db, `SELECT id, display_name, brand_id FROM inbox_customers WHERE id=$1 AND workspace_id=$2`, [ct.customer_id, ctx.access.workspaceId]) : null;
  const ids = cust ? await many<{ contact_id: string; display_name: string | null; handle: string | null; kind: ChannelKind; ch_name: string; linked_at: Date; linked_by: string | null; method: string }>(db,
    `SELECT l.contact_id, ct.display_name, ct.handle, ch.kind, ch.display_name AS ch_name, l.linked_at, l.linked_by, l.method
       FROM inbox_identity_links l JOIN inbox_contacts ct ON ct.id=l.contact_id JOIN inbox_channels ch ON ch.id=ct.channel_id
      WHERE l.customer_id=$1 AND l.unlinked_at IS NULL AND ch.brand_id = ANY($2::uuid[]) ORDER BY l.linked_at`, [cust.id, brands]) : [];
  const contactIds = cust ? ids.map((i) => i.contact_id) : [ct.id];
  const convs = await many<{ id: string; kind: string; preview: string; status: string; last_message_at: Date; ch_kind: ChannelKind }>(db,
    `SELECT c.id, c.kind, c.preview, c.status, c.last_message_at, ch.kind AS ch_kind FROM inbox_conversations c JOIN inbox_channels ch ON ch.id=c.channel_id
      WHERE c.workspace_id=$1 AND c.contact_id = ANY($2::uuid[]) AND c.brand_id = ANY($3::uuid[]) AND c.id <> $4 ORDER BY c.last_message_at DESC LIMIT 10`,
    [ctx.access.workspaceId, contactIds, brands, conv.id]);
  const hist = await many<{ linked_at: Date; linked_by: string | null; unlinked_at: Date | null; unlinked_by: string | null; reason: string | null; name: string }>(db,
    `SELECT l.linked_at, l.linked_by, l.unlinked_at, l.unlinked_by, l.reason, cu.display_name AS name FROM inbox_identity_links l JOIN inbox_customers cu ON cu.id=l.customer_id
      WHERE l.contact_id=$1 ORDER BY l.linked_at DESC LIMIT 20`, [ct.id]);
  const ppl = await people(db, [...ids.map((i) => i.linked_by), ...hist.flatMap((h) => [h.linked_by, h.unlinked_by])]);
  const history: CustomerProfileDto['history'] = [];
  for (const h of hist) {
    const [linkReason, unlinkReason] = (h.reason ?? '').split(/(?: · )?unlinked: /);
    if (h.unlinked_at) history.push({ action: 'unlinked', at: h.unlinked_at.toISOString(), by: h.unlinked_by ? ppl.get(h.unlinked_by) ?? null : null, reason: unlinkReason || null, customer_name: h.name });
    history.push({ action: 'linked', at: h.linked_at.toISOString(), by: h.linked_by ? ppl.get(h.linked_by) ?? null : null, reason: linkReason || null, customer_name: h.name });
  }
  return {
    contact: { id: ct.id, name: ct.display_name, handle: ct.handle, channel: { kind: ct.kind, display_name: ct.ch_name }, first_seen_at: ct.first_seen_at.toISOString() },
    customer: cust ? { id: cust.id, name: cust.display_name, brand_id: cust.brand_id } : null,
    identities: ids.map((i) => ({ contact_id: i.contact_id, name: i.display_name, handle: i.handle, channel_kind: i.kind, channel_name: i.ch_name, linked_at: i.linked_at.toISOString(), linked_by: i.linked_by ? ppl.get(i.linked_by) ?? null : null, method: i.method })),
    conversations: convs.map((c) => ({ id: c.id, channel_kind: c.ch_kind, kind: c.kind, preview: c.preview, status: c.status, last_message_at: c.last_message_at.toISOString() })),
    history: history.sort((a, b) => b.at.localeCompare(a.at)),
    can_link: canLink,
  };
}

/** Pick an existing customer by explicit choice (search is only a picker; nothing is linked automatically). */
export async function searchCustomers(ctx: Ctx, q: { q?: string | null; brand_id?: string | null }): Promise<{ items: Array<{ id: string; name: string; identities: number }> }> {
  requireAction(ctx, 'cases.manage', q.brand_id ? { brandId: q.brand_id } : undefined);
  const term = `%${(q.q ?? '').trim().slice(0, 80).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const rows = await many<{ id: string; display_name: string; brand_id: string | null; n: number }>(getPool(),
    `SELECT cu.id, cu.display_name, cu.brand_id, (SELECT count(*)::int FROM inbox_identity_links l WHERE l.customer_id=cu.id AND l.unlinked_at IS NULL) n
       FROM inbox_customers cu WHERE cu.workspace_id=$1 AND cu.merged_into IS NULL AND cu.display_name ILIKE $2 AND ($3::uuid IS NULL OR cu.brand_id IS NULL OR cu.brand_id=$3)
      ORDER BY cu.updated_at DESC LIMIT 20`, [ctx.access.workspaceId, term, q.brand_id ?? null]);
  return { items: rows.filter((r) => !r.brand_id || brandAllowed(ctx, r.brand_id)).map((r) => ({ id: r.id, name: r.display_name, identities: r.n })) };
}

export const linkSchema = z.union([
  z.object({ customer_id: z.string().uuid(), reason: z.string().trim().min(3).max(200) }).strict(),
  z.object({ new_customer_name: z.string().trim().min(1).max(120), reason: z.string().trim().min(3).max(200) }).strict(),
]);
export const unlinkSchema = z.object({ reason: z.string().trim().min(3).max(200) }).strict();

async function contactFor(ctx: Ctx, conversationId: string) {
  const conv = await loadConversation(ctx, conversationId, 'inbox.read');
  requireAction(ctx, 'cases.manage', { brandId: conv.brand_id });
  if (!conv.contact_id) throw new AppError('invalid_state', 'This conversation has no customer identity.');
  return conv;
}

export async function linkIdentity(ctx: Ctx, conversationId: string, input: z.infer<typeof linkSchema>): Promise<CustomerProfileDto> {
  const conv = await contactFor(ctx, conversationId);
  await withTx(async (tx) => {
    const ct = await one<{ id: string; customer_id: string | null }>(tx, `SELECT id, customer_id FROM inbox_contacts WHERE id=$1 FOR UPDATE`, [conv.contact_id]);
    if (ct.customer_id) throw new AppError('conflict', 'This identity is already linked. Unlink it first.');
    let customerId: string;
    if ('customer_id' in input) {
      const cu = await maybeOne<{ id: string; brand_id: string | null }>(tx, `SELECT id, brand_id FROM inbox_customers WHERE id=$1 AND workspace_id=$2 AND merged_into IS NULL`, [input.customer_id, ctx.access.workspaceId]);
      if (!cu || (cu.brand_id && cu.brand_id !== conv.brand_id)) throw notFound('Customer');
      customerId = cu.id;
    } else {
      customerId = (await one<{ id: string }>(tx, `INSERT INTO inbox_customers(workspace_id, brand_id, display_name, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.access.workspaceId, conv.brand_id, input.new_customer_name, ctx.actor.userId])).id;
    }
    await tx.query(`INSERT INTO inbox_identity_links(workspace_id, customer_id, contact_id, method, reason, linked_by) VALUES ($1,$2,$3,'explicit_link',$4,$5)`, [ctx.access.workspaceId, customerId, ct.id, input.reason, ctx.actor.userId]);
    await tx.query(`UPDATE inbox_contacts SET customer_id=$2 WHERE id=$1`, [ct.id, customerId]);
    await tx.query(`UPDATE inbox_customers SET updated_at=now() WHERE id=$1`, [customerId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: conv.brand_id, actorUserId: ctx.actor.userId, action: 'inbox.identity_linked', resourceType: 'inbox_contact', resourceId: ct.id, diff: { customer_id: customerId, created: !('customer_id' in input) }, correlationId: ctx.correlationId });
  }).catch((err: unknown) => {
    if ((err as { constraint?: string }).constraint === 'inbox_identity_links_live_uniq') throw new AppError('conflict', 'This identity is already linked. Unlink it first.');
    throw err;
  });
  return customerProfile(ctx, conversationId);
}

export async function unlinkIdentity(ctx: Ctx, conversationId: string, input: z.infer<typeof unlinkSchema>): Promise<CustomerProfileDto> {
  const conv = await contactFor(ctx, conversationId);
  await withTx(async (tx) => {
    const l = await maybeOne<{ id: string; customer_id: string }>(tx, `SELECT id, customer_id FROM inbox_identity_links WHERE contact_id=$1 AND unlinked_at IS NULL FOR UPDATE`, [conv.contact_id]);
    if (!l) throw new AppError('invalid_state', 'This identity is not linked.');
    await tx.query(`UPDATE inbox_identity_links SET unlinked_at=now(), unlinked_by=$2, reason=coalesce(reason, '') || CASE WHEN reason IS NULL THEN '' ELSE ' · ' END || $3 WHERE id=$1`, [l.id, ctx.actor.userId, `unlinked: ${input.reason}`]);
    await tx.query(`UPDATE inbox_contacts SET customer_id=NULL WHERE id=$1`, [conv.contact_id]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: conv.brand_id, actorUserId: ctx.actor.userId, action: 'inbox.identity_unlinked', resourceType: 'inbox_contact', resourceId: conv.contact_id!, diff: { customer_id: l.customer_id, reason: input.reason }, correlationId: ctx.correlationId });
  });
  return customerProfile(ctx, conversationId);
}
