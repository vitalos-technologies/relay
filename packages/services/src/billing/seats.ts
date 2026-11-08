// Billable seats (V5 §5; core/contracts/v4-plans.ts "seats"). ONE function used by checkout, settings, Platform admin,
// webhooks and invite/accept checks.
// Billable user = active, accepted workspace member (owner included) whose account is not disabled by Relay.
// Not billable: pending invitations, Relay operators present only through an active support-access grant
// (support_access_grants.created_membership), service accounts (not memberships), suspended/removed members, and guests
// holding only the `guest` preset — free up to GUEST_SEAT_EXEMPTION.max_free_guests; guests beyond the cap are billable.
import { AppError } from '@social-lite/core';
import { GUEST_SEAT_EXEMPTION, MIN_PAID_SEATS, PLANS, formatMinorGBP, type PlanId } from '@social-lite/core/contracts/v4-plans';
import { getPool, one, type Queryable } from '@social-lite/db';
import { hasPaidSubscription } from './policy.js';
import { loadBilling } from './store.js';

export interface SeatCount {
  billable: number;
  members: number;
  free_guests: number;
  billable_guests: number;
  support_operators: number;
  pending_member_invites: number;
  pending_guest_invites: number;
}

export async function seatCount(db: Queryable, workspaceId: string): Promise<SeatCount> {
  const r = await one<{ members: number; guests: number; ops: number; pend_m: number; pend_g: number }>(db,
    `WITH m AS (
       SELECT m.user_id,
              EXISTS (SELECT 1 FROM support_access_grants s WHERE s.workspace_id=m.workspace_id AND s.operator_user_id=m.user_id AND s.status='active' AND s.created_membership) AS support_op,
              EXISTS (SELECT 1 FROM scoped_role_grants g WHERE g.workspace_id=m.workspace_id AND g.user_id=m.user_id AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now()) AND g.role = 'guest')
                AND NOT EXISTS (SELECT 1 FROM scoped_role_grants g WHERE g.workspace_id=m.workspace_id AND g.user_id=m.user_id AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now()) AND g.role <> 'guest')
                AND NOT EXISTS (SELECT 1 FROM team_memberships t JOIN scoped_role_grants g ON g.team_id=t.team_id AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
                                 WHERE t.workspace_id=m.workspace_id AND t.user_id=m.user_id) AS guest_only
         FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE m.workspace_id=$1 AND m.status='active' AND m.removed_at IS NULL AND u.disabled_at IS NULL
     )
     SELECT count(*) FILTER (WHERE NOT support_op AND NOT guest_only)::int members,
            count(*) FILTER (WHERE NOT support_op AND guest_only)::int guests,
            count(*) FILTER (WHERE support_op)::int ops,
            (SELECT count(*)::int FROM invitations i WHERE i.workspace_id=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() AND coalesce(i.kind,'member') <> 'guest') pend_m,
            (SELECT count(*)::int FROM invitations i WHERE i.workspace_id=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() AND i.kind = 'guest') pend_g
       FROM m`, [workspaceId]);
  const freeGuests = Math.min(r.guests, GUEST_SEAT_EXEMPTION.max_free_guests);
  const billableGuests = r.guests - freeGuests;
  return {
    billable: r.members + billableGuests, members: r.members, free_guests: freeGuests, billable_guests: billableGuests,
    support_operators: r.ops, pending_member_invites: r.pend_m, pending_guest_invites: r.pend_g,
  };
}

/** The number of billable users (the contract name used across V4/V5). */
export async function billableSeats(db: Queryable, workspaceId: string): Promise<number> {
  return (await seatCount(db, workspaceId)).billable;
}

/** Seats a paid subscription must carry: at least one, and at least the billable users. */
export function requiredSeats(billable: number): number {
  return Math.max(MIN_PAID_SEATS, billable);
}

export interface SeatCheck {
  enforced: boolean;
  paid_seats: number;
  billable: number;
  pending_member_invites: number;
  free_seats: number;
  plan_id: PlanId;
  unit_amount_minor: number | null;
}

export async function seatCheck(db: Queryable, workspaceId: string): Promise<SeatCheck> {
  const b = await loadBilling(db, workspaceId);
  const c = await seatCount(db, workspaceId);
  const enforced = !!b && hasPaidSubscription(b.status, b.provider_subscription_ref);
  const paid = b?.seats ?? 0;
  return {
    enforced, paid_seats: paid, billable: c.billable, pending_member_invites: c.pending_member_invites,
    free_seats: enforced ? Math.max(0, paid - c.billable - c.pending_member_invites) : Number.POSITIVE_INFINITY,
    plan_id: b?.plan_id ?? 'legacy', unit_amount_minor: PLANS[b?.plan_id ?? 'legacy'].unit_amount_minor,
  };
}

const lockSeats = (db: Queryable, workspaceId: string) => db.query(`SELECT pg_advisory_xact_lock(hashtext('billing-seats:' || $1::text))`, [workspaceId]);

function seatError(c: SeatCheck): AppError {
  const price = c.unit_amount_minor != null ? ` (${formatMinorGBP(c.unit_amount_minor)} per user / month)` : '';
  return new AppError('conflict', `All ${c.paid_seats} paid seats are in use. Add a seat in Billing${price}, then invite.`, undefined,
    { reason: 'seat_limit', paid_seats: c.paid_seats, billable: c.billable, pending_member_invites: c.pending_member_invites, billing_href: '/settings/workspace/billing' });
}

/**
 * Invitation (inside the inviter's transaction). Only a paid subscription limits invites; pending member invitations
 * reserve seats. Never adds paid seats silently — seat increases happen in Billing with the cost shown.
 * Guest invites are free while the workspace is under the free-guest cap.
 */
export async function assertSeatForInvite(tx: Queryable, workspaceId: string, kind: 'member' | 'guest'): Promise<void> {
  await lockSeats(tx, workspaceId);
  const c = await seatCheck(tx, workspaceId);
  if (!c.enforced) return;
  if (kind === 'guest') {
    const sc = await seatCount(tx, workspaceId);
    if (sc.free_guests + sc.pending_guest_invites < GUEST_SEAT_EXEMPTION.max_free_guests) return;
  }
  if (c.free_seats < 1) throw seatError(c);
}

/** Acceptance re-check (seats may have been reduced since the invitation). Returns false when no seat is free. */
export async function seatAvailableOnAccept(tx: Queryable, workspaceId: string, kind: 'member' | 'guest'): Promise<boolean> {
  await lockSeats(tx, workspaceId);
  const c = await seatCheck(tx, workspaceId);
  if (!c.enforced) return true;
  const sc = await seatCount(tx, workspaceId);
  if (kind === 'guest' && sc.free_guests < GUEST_SEAT_EXEMPTION.max_free_guests) return true;
  // The accepting invitation is itself one of the pending ones: it may use its reserved seat.
  return c.paid_seats - c.billable >= 1;
}

export async function seatsPreview(workspaceId: string, add: number, db: Queryable = getPool()) {
  const c = await seatCheck(db, workspaceId);
  const next = c.paid_seats + Math.max(0, add);
  return { ...c, free_seats: Number.isFinite(c.free_seats) ? c.free_seats : null, next_seats: next,
    next_recurring_minor: c.unit_amount_minor != null ? c.unit_amount_minor * next : null };
}
