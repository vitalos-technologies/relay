// Relay support (V4 SUP) — who may see and act on a ticket. Server-enforced; navigation only mirrors it.
// Customer side (docs/v4/SUPPORT_VISIBILITY_MATRIX.md):
//   * the requester (still an active member of the ticket's workspace — guaranteed by the request context);
//   * explicitly added participants (active members of the same workspace);
//   * holders of `support.workspace` (owners/admins by preset) for the workspace's NON-restricted tickets.
//   Restricted tickets (security / private account matters) stay with the requester and participants only.
//   Support-access grants (viewer preset) never include support.workspace, so a Relay operator holding temporary
//   workspace access still cannot read customers' support requests through the customer API.
// Staff side: platform role 'support' or 'operator' (re-read from the database per request). 'billing' (and any other
// staff role) gets nothing from support endpoints — no ticket content and no internal notes.
import { AppError, notFound } from '@social-lite/core';
import { maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { authorizeCtx, isUuid, loadAccess } from '../tenancy.js';
import type { PlatformCtx } from '../admin/platform.js';

export const SUPPORT_STAFF_ROLES = ['operator', 'support'] as const;

export function isSupportStaffRole(role: string | null | undefined): boolean {
  return !!role && (SUPPORT_STAFF_ROLES as readonly string[]).includes(role);
}

/** Support staff only ('support' or 'operator'). Billing staff and anyone else are refused. */
export function requireSupportStaff(p: PlatformCtx): void {
  if (!isSupportStaffRole(p.role)) throw new AppError('forbidden', 'Support staff only');
}

/** Is this user an active support staff member right now (for assignment targets and delivery re-checks)? */
export async function activeSupportStaff(db: Queryable, userId: string): Promise<boolean> {
  const r = await maybeOne<{ role: string }>(db,
    `SELECT o.role FROM platform_operators o JOIN users u ON u.id=o.user_id WHERE o.user_id=$1 AND o.revoked_at IS NULL AND u.disabled_at IS NULL`, [userId]);
  return isSupportStaffRole(r?.role);
}

/** Workspace-wide support visibility (non-restricted tickets). */
export function canSeeWorkspaceTickets(ctx: Ctx): boolean {
  return authorizeCtx(ctx, 'support.workspace').allowed;
}

/**
 * SQL predicate (alias `t`) for tickets the caller may see. Parameters: $ws, $user, $canWs (boolean) at the given
 * positions. Always combined with t.workspace_id = $ws.
 */
export function visibleSql(ws: number, user: number, canWs: number): string {
  return `t.workspace_id = $${ws} AND t.requester_kind = 'member' AND (
    t.requester_user_id = $${user}
    OR EXISTS (SELECT 1 FROM support_ticket_participants sp WHERE sp.ticket_id = t.id AND sp.user_id = $${user} AND sp.removed_at IS NULL)
    OR ($${canWs}::boolean AND NOT t.restricted))`;
}

export interface VisibleTicket {
  id: string; reference: string; workspace_id: string; requester_user_id: string | null; restricted: boolean; status: string; category: string;
  subject: string; resolved_at: Date | null; archived_at: Date | null; mine: boolean; participant: boolean;
}

/** Load a ticket the caller may see by id or reference; otherwise not_found (no existence leakage). */
export async function loadVisibleTicket(ctx: Ctx, idOrRef: string, db: Queryable, lock = false): Promise<VisibleTicket> {
  const byId = isUuid(idOrRef);
  if (!byId && !/^RLY-[0-9]{5,10}$/i.test(idOrRef)) throw notFound('Request');
  const t = await maybeOne<VisibleTicket>(db,
    `SELECT t.id, t.reference, t.workspace_id, t.requester_user_id, t.restricted, t.status, t.category, t.subject, t.resolved_at, t.archived_at,
            (t.requester_user_id = $2) AS mine,
            EXISTS (SELECT 1 FROM support_ticket_participants sp WHERE sp.ticket_id=t.id AND sp.user_id=$2 AND sp.removed_at IS NULL) AS participant
       FROM support_tickets t
      WHERE ${byId ? 't.id = $4::uuid' : 'upper(t.reference) = upper($4)'} AND ${visibleSql(1, 2, 3)} ${lock ? 'FOR UPDATE OF t' : ''}`,
    [ctx.access.workspaceId, ctx.actor.userId, canSeeWorkspaceTickets(ctx), idOrRef]);
  if (!t) throw notFound('Request');
  return t;
}

/**
 * Delivery-time re-check for a customer recipient (notifications, email): still an active member with current policy,
 * and the ticket is still visible to them.
 */
export async function customerCanSee(db: Queryable, userId: string, ticketId: string): Promise<boolean> {
  if (!isUuid(ticketId)) return false;
  const t = await maybeOne<{ workspace_id: string | null }>(db, `SELECT workspace_id FROM support_tickets WHERE id=$1 AND requester_kind='member'`, [ticketId]);
  if (!t?.workspace_id) return false;
  const access = await loadAccess(userId, t.workspace_id, db);
  if (!access) return false;
  const ctx: Ctx = { actor: { userId, email: '', name: null, sessionId: 'delivery' }, access, correlationId: 'delivery' };
  const r = await maybeOne(db, `SELECT 1 FROM support_tickets t WHERE t.id=$4 AND ${visibleSql(1, 2, 3)}`, [t.workspace_id, userId, canSeeWorkspaceTickets(ctx), ticketId]);
  return !!r;
}
