// Team invitations: single-use, 7-day expiry, bound to an email address. Only sha256(token) is
// stored; the token appears once in the create response (accept_url) and in the email.
// Acceptance happens in the OIDC callback (auth/oidc.ts) with the VERIFIED login email.
import { AppError, ROLES, notFound, type Role } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { audit } from '../audit.js';
import { config } from '../config.js';
import type { Ctx } from '../context.js';
import { invitationEmail, sendMail } from '../email.js';
import { beginIdempotent, completeIdempotent } from '../idempotency.js';
import { assertUuid, isUuid, requireAction } from '../tenancy.js';
import { randomToken, sha256 } from './session.js';
import { LoginError } from './users.js';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface InvitationDto {
  id: string; email: string; role: Role; brand_ids: string[]; expires_at: string; created_at: string;
  invited_by_email: string | null; status: 'pending' | 'expired';
}

interface InvitationRow {
  id: string; workspace_id: string; email: string; role: Role; brand_ids: string[]; expires_at: Date; created_at: Date;
  invited_by_email: string | null; accepted_at: Date | null; revoked_at: Date | null;
}

const toDto = (r: InvitationRow): InvitationDto => ({
  id: r.id, email: r.email, role: r.role, brand_ids: r.brand_ids, expires_at: r.expires_at.toISOString(), created_at: r.created_at.toISOString(),
  invited_by_email: r.invited_by_email, status: r.expires_at.getTime() <= Date.now() ? 'expired' : 'pending',
});

export const acceptUrl = (token: string) => `${config().APP_BASE_URL.replace(/\/$/, '')}/invite/${encodeURIComponent(token)}`;

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

/** Open (not accepted, not revoked) invitations, including expired ones so they can be re-sent/revoked. */
export async function listInvitations(ctx: Ctx, db: Queryable = getPool()): Promise<InvitationDto[]> {
  if (ctx.access.role !== 'owner' && ctx.access.role !== 'admin') return [];
  const rows = await many<InvitationRow>(db,
    `SELECT i.*, u.email AS invited_by_email FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.workspace_id=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL ORDER BY i.created_at DESC`, [ctx.access.workspaceId]);
  return rows.map(toDto);
}

export interface CreateInvitationInput { email: string; role: Role; brand_ids?: string[] }
export type CreateInvitationResult = InvitationDto & { accept_url?: string; email_sent: boolean };

export async function createInvitation(ctx: Ctx, input: CreateInvitationInput, idempotencyKey: string | null): Promise<{ status: number; body: CreateInvitationResult }> {
  requireAction(ctx, 'members.invite');
  const email = input.email.trim();
  if (!EMAIL_RE.test(email) || email.length > 320) throw new AppError('validation_failed', 'Enter a valid email address', { email: 'Enter a valid email address' });
  if (!(ROLES as readonly string[]).includes(input.role)) throw new AppError('validation_failed', 'Unknown role', { role: 'Unknown role' });
  if (input.role === 'owner') throw new AppError('validation_failed', 'Invite as admin, then transfer ownership', { role: 'Owners cannot be invited directly' });
  const brandIds = [...new Set(input.brand_ids ?? [])];
  if (brandIds.some((b) => !isUuid(b))) throw new AppError('validation_failed', 'Unknown brand', { brand_ids: 'Unknown brand' });
  if (brandIds.length && input.role === 'admin') {
    throw new AppError('validation_failed', 'Admins always have access to every brand', { brand_ids: 'Brand restrictions do not apply to admins' });
  }

  const token = randomToken(32);
  const result = await withTx(async (tx) => {
    const replay = await beginIdempotent(tx, { workspaceId: ctx.access.workspaceId, userId: ctx.actor.userId, action: 'invitations.create', key: idempotencyKey, body: input });
    if (replay) return { replay: replay as { status: number; body: CreateInvitationResult } };

    if (brandIds.length) {
      const found = await many<{ id: string }>(tx, `SELECT id FROM brands WHERE workspace_id=$1 AND id = ANY($2::uuid[]) AND archived_at IS NULL`, [ctx.access.workspaceId, brandIds]);
      if (found.length !== brandIds.length) throw new AppError('validation_failed', 'Unknown brand', { brand_ids: 'Unknown brand' });
    }
    const member = await maybeOne<{ user_id: string }>(tx,
      `SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND u.email=$2 AND m.removed_at IS NULL`,
      [ctx.access.workspaceId, email]);
    if (member) throw new AppError('conflict', 'This person is already a member of the workspace.');
    const open = await maybeOne<{ id: string; expires_at: Date }>(tx,
      `SELECT id, expires_at FROM invitations WHERE workspace_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE`,
      [ctx.access.workspaceId, email]);
    if (open) {
      if (open.expires_at.getTime() > Date.now()) throw new AppError('conflict', 'An invitation for this email is already pending. Revoke it to send a new one.');
      await tx.query(`UPDATE invitations SET revoked_at=now() WHERE id=$1`, [open.id]); // replace expired invitation
    }
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    const row = await maybeOne<{ id: string }>(tx,
      `INSERT INTO invitations(workspace_id, email, role, brand_ids, token_hash, invited_by, expires_at)
       VALUES ($1,$2,$3,$4::uuid[],$5,$6,$7) RETURNING id`,
      [ctx.access.workspaceId, email, input.role, brandIds, sha256(token), ctx.actor.userId, expiresAt]);
    const inv = (await maybeOne<InvitationRow>(tx,
      `SELECT i.*, u.email AS invited_by_email FROM invitations i LEFT JOIN users u ON u.id=i.invited_by WHERE i.id=$1`, [row!.id]))!;
    const ws = (await maybeOne<{ name: string }>(tx, `SELECT name FROM workspaces WHERE id=$1`, [ctx.access.workspaceId]))!;
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'invitation.created', resourceType: 'invitation',
      resourceId: inv.id, diff: { email, role: input.role, brand_ids: brandIds }, correlationId: ctx.correlationId });
    // The stored idempotent response deliberately omits the token-bearing accept_url.
    const stored: CreateInvitationResult = { ...toDto(inv), email_sent: false };
    await completeIdempotent(tx, { workspaceId: ctx.access.workspaceId, action: 'invitations.create', key: idempotencyKey!, status: 201, body: stored });
    return { inv, wsName: ws.name };
  });
  if ('replay' in result) return result.replay!;

  // Send synchronously AFTER commit (never inside the transaction).
  const url = acceptUrl(token);
  const sent = await sendMail(invitationEmail({ to: email, workspaceName: result.wsName, inviterEmail: ctx.actor.email, role: input.role, acceptUrl: url, expiresAt: result.inv.expires_at }));
  if (sent) {
    await getPool().query(
      `UPDATE idempotency_keys SET response_body = jsonb_set(response_body, '{email_sent}', 'true') WHERE workspace_id=$1 AND action='invitations.create' AND key=$2`,
      [ctx.access.workspaceId, idempotencyKey]);
  }
  return { status: 201, body: { ...toDto(result.inv), accept_url: url, email_sent: sent } };
}

export async function revokeInvitation(ctx: Ctx, invitationId: string): Promise<void> {
  requireAction(ctx, 'members.invite');
  assertUuid(invitationId, 'Invitation');
  await withTx(async (tx) => {
    const r = await maybeOne<{ id: string; email: string; accepted_at: Date | null; revoked_at: Date | null }>(tx,
      `SELECT id, email, accepted_at, revoked_at FROM invitations WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [invitationId, ctx.access.workspaceId]);
    if (!r) throw notFound('Invitation');
    if (r.accepted_at) throw new AppError('invalid_state', 'This invitation was already accepted. Remove the member instead.');
    if (r.revoked_at) return;
    await tx.query(`UPDATE invitations SET revoked_at=now() WHERE id=$1`, [r.id]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'invitation.revoked', resourceType: 'invitation',
      resourceId: r.id, diff: { email: r.email }, correlationId: ctx.correlationId });
  });
}

export type InvitationStatus = 'pending' | 'expired' | 'accepted' | 'revoked';

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const shown = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${shown}${'*'.repeat(Math.max(3, local.length - shown.length))}@${domain}`;
}

/** Public preview for the invite landing page. Reveals only a masked email. */
export async function previewInvitation(token: string, db: Queryable = getPool()): Promise<{ workspace_name: string; email_hint: string; role: Role; expires_at: string; status: InvitationStatus }> {
  if (!token || token.length > 200) throw notFound('Invitation');
  const r = await maybeOne<{ name: string; email: string; role: Role; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null }>(db,
    `SELECT w.name, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at
       FROM invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE i.token_hash=$1`, [sha256(token)]);
  if (!r) throw notFound('Invitation');
  const status: InvitationStatus = r.accepted_at ? 'accepted' : r.revoked_at ? 'revoked' : r.expires_at.getTime() <= Date.now() ? 'expired' : 'pending';
  return { workspace_name: r.name, email_hint: maskEmail(r.email), role: r.role, expires_at: r.expires_at.toISOString(), status };
}

/**
 * Accept an invitation for an authenticated user whose VERIFIED email must equal the invited email
 * (case-insensitive). Single use. Must run inside a transaction. Throws LoginError with a stable code.
 */
export async function acceptInvitation(tx: Queryable, tokenHash: Buffer, user: { id: string; email: string }): Promise<{ workspaceId: string; alreadyMember: boolean }> {
  const inv = await maybeOne<{ id: string; workspace_id: string; email: string; role: Role; brand_ids: string[]; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null; state: string }>(tx,
    `SELECT i.id, i.workspace_id, i.email, i.role, i.brand_ids, i.expires_at, i.accepted_at, i.revoked_at, w.state
       FROM invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE i.token_hash=$1 FOR UPDATE OF i`, [tokenHash]);
  if (!inv) throw new LoginError('invitation_invalid', 'This invitation link is not valid.');
  if (inv.accepted_at) throw new LoginError('invitation_used', 'This invitation has already been used.');
  if (inv.revoked_at) throw new LoginError('invitation_revoked', 'This invitation was revoked. Ask for a new one.');
  if (inv.expires_at.getTime() <= Date.now()) throw new LoginError('invitation_expired', 'This invitation has expired. Ask for a new one.');
  if (inv.state !== 'active') throw new LoginError('invitation_invalid', 'This workspace is not available.');
  if (inv.email.toLowerCase() !== user.email.trim().toLowerCase()) {
    throw new LoginError('email_mismatch', 'This invitation was sent to a different email address. Sign in with the invited address.');
  }

  const m = await maybeOne<{ removed_at: Date | null }>(tx,
    `SELECT removed_at FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE`, [inv.workspace_id, user.id]);
  const alreadyMember = !!m && m.removed_at === null;
  if (!alreadyMember) {
    const restricted = inv.brand_ids.length > 0;
    if (m) {
      await tx.query(
        `UPDATE memberships SET role=$3, brand_restricted=$4, removed_at=NULL, removed_by=NULL, created_at=now() WHERE workspace_id=$1 AND user_id=$2`,
        [inv.workspace_id, user.id, inv.role, restricted]);
      await tx.query(`DELETE FROM membership_brand_grants WHERE workspace_id=$1 AND user_id=$2`, [inv.workspace_id, user.id]);
    } else {
      await tx.query(`INSERT INTO memberships(workspace_id, user_id, role, brand_restricted) VALUES ($1,$2,$3,$4)`,
        [inv.workspace_id, user.id, inv.role, restricted]);
    }
    if (restricted) {
      // Only brands that still exist in the workspace are granted (composite FK enforces tenancy).
      await tx.query(
        `INSERT INTO membership_brand_grants(workspace_id, user_id, brand_id)
         SELECT $1, $2, b.id FROM brands b WHERE b.workspace_id=$1 AND b.id = ANY($3::uuid[]) ON CONFLICT DO NOTHING`,
        [inv.workspace_id, user.id, inv.brand_ids]);
    }
  }
  await tx.query(`UPDATE invitations SET accepted_at=now(), accepted_by=$2 WHERE id=$1`, [inv.id, user.id]);
  await audit(tx, { workspaceId: inv.workspace_id, actorUserId: user.id, action: 'invitation.accepted', resourceType: 'invitation',
    resourceId: inv.id, diff: { role: inv.role, brand_ids: inv.brand_ids, already_member: alreadyMember } });
  return { workspaceId: inv.workspace_id, alreadyMember };
}
