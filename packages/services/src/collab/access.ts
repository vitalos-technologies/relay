// Entitlement helpers for collaboration features (stream C). Always evaluated through the central policy
// (authz.ts). "Staff" access = a non-guest grant; guest grants only ever reach explicitly shared reviews.
import type { Permission } from '@social-lite/core';
import { maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { authorize, loadUserAuthz, type AuthzState } from '../authz.js';

/** Allowed AND at least one allowing grant is not a guest grant. */
export function staffAllowed(state: AuthzState, perm: Permission, brandId: string): boolean {
  const d = authorize(state, perm, { brandId });
  return d.allowed && d.sources.some((s) => s.role !== 'guest');
}

/** A user whose only live grants are guest grants (review portal only). */
export function isGuestOnly(state: AuthzState | undefined): boolean {
  if (!state || state.subject.status !== 'active') return false;
  const live = state.subject.grants.filter((g) => !g.expiresAt || new Date(g.expiresAt).getTime() > Date.now());
  return live.length > 0 && live.every((g) => g.role === 'guest');
}

export async function hasActiveShare(db: Queryable, workspaceId: string, postId: string, userId: string): Promise<boolean> {
  return !!(await maybeOne(db, `SELECT 1 FROM review_shares WHERE workspace_id=$1 AND post_id=$2 AND user_id=$3 AND revoked_at IS NULL`, [workspaceId, postId, userId]));
}

/** Requirement a notification recipient must STILL meet (checked at send, at email time and at read). */
export type Requirement = { brandId: string; permission: Permission | 'review.shared'; postId?: string | null };

/**
 * Is `userId` entitled right now? 'review.shared' = staff with content.read on the brand, OR a guest with a live
 * guest grant on the brand AND an active share of the post. Other permissions require a staff grant.
 */
export async function entitledNow(db: Queryable, workspaceId: string, userId: string, req: Requirement, state?: AuthzState): Promise<boolean> {
  const s = state ?? await loadUserAuthz(userId, workspaceId, null, db);
  if (s.subject.status !== 'active') return false;
  if (req.permission === 'review.shared') {
    if (staffAllowed(s, 'content.read', req.brandId)) return true;
    if (!req.postId || !authorize(s, 'content.read', { brandId: req.brandId }).allowed) return false;
    return hasActiveShare(db, workspaceId, req.postId, userId);
  }
  return staffAllowed(s, req.permission, req.brandId);
}

/** Same check for the caller of a request (uses the request's already-loaded policy state). */
export async function callerEntitled(ctx: Ctx, db: Queryable, req: Requirement): Promise<boolean> {
  return entitledNow(db, ctx.access.workspaceId, ctx.actor.userId, req, ctx.access.authz);
}
