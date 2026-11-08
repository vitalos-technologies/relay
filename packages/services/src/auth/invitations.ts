// Invitations v2. An invitation carries: workspace, intended email, scoped role grants (server-validated),
// optional teams, inviting actor and expiry (default 72 h = workspaces.security_policy.invite_ttl_hours).
//  - Tokens: 32 random bytes, single use, only sha256(token) stored; shown once (create/resend response + email).
//  - Resend rotates the token (the old link stops working) and restarts the expiry.
//  - Acceptance is atomic (row lock): concurrent acceptance succeeds exactly once.
//  - Acceptance requires the authenticated identity (issuer+subject user) whose IdP-VERIFIED email equals
//    the invited email. Accounts are never linked by an unverified email claim.
//  - The inviter's delegation ceiling is checked at creation AND again at acceptance (revoked inviters' invites die).
//  - Guests: brand/connection-scoped guest grants with a REQUIRED expiry (default 30 days, max policy guest_max_days).
//  - Public preview reveals only workspace name, masked email, role summary, expiry and status (no user enumeration).
import { AppError, notFound, type Role, type RolePreset } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { audit } from '../audit.js';
import { config } from '../config.js';
import type { Ctx } from '../context.js';
import { invitationEmail, sendMail } from '../email.js';
import { beginIdempotent, completeIdempotent } from '../idempotency.js';
import { loadUserAuthz } from '../authz.js';
import { canAnywhere } from '../access.js';
import {
  GRANTABLE_ROLES, assertDelegable, commitPolicyChange, legacySummary, mayDelegate, needsStepUp, normalizeGrants, upsertGrant, workspacePolicy,
  type GrantInput, type NormalizedGrant,
} from '../grants.js';
import { assertUuid, isUuid, requireAction } from '../tenancy.js';
import { randomToken, sha256 } from './session.js';
import { LoginError, PENDING_ISSUER } from './users.js';

/** Default TTL when the workspace policy has none (72 h). */
export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;

interface StoredGrant { role: RolePreset; scope_type: NormalizedGrant['scopeType']; brand_id: string | null; connection_id: string | null }

export interface InvitationDto {
  id: string; email: string; role: Role; brand_ids: string[]; expires_at: string; created_at: string;
  invited_by_email: string | null; status: 'pending' | 'expired';
  kind: 'member' | 'guest'; access_expires_at: string | null; resent_count: number; last_sent_at: string | null;
  grants: Array<StoredGrant & { brand_name: string | null; connection_name: string | null }>; teams: Array<{ id: string; name: string }>;
}

interface InvitationRow {
  id: string; workspace_id: string; email: string; role: Role; brand_ids: string[]; expires_at: Date; created_at: Date;
  invited_by: string; invited_by_email: string | null; accepted_at: Date | null; revoked_at: Date | null; grants: StoredGrant[]; team_ids: string[];
  kind: 'member' | 'guest'; access_expires_at: Date | null; resent_count: number; last_sent_at: Date | null;
}

const INV_SELECT = `SELECT i.*, u.email AS invited_by_email FROM invitations i LEFT JOIN users u ON u.id = i.invited_by`;

async function toDtos(db: Queryable, rows: InvitationRow[]): Promise<InvitationDto[]> {
  const brandIds = [...new Set(rows.flatMap((r) => r.grants.map((g) => g.brand_id)).filter((b): b is string => !!b))];
  const connIds = [...new Set(rows.flatMap((r) => r.grants.map((g) => g.connection_id)).filter((c): c is string => !!c))];
  const teamIds = [...new Set(rows.flatMap((r) => r.team_ids))];
  const names = new Map<string, string>();
  if (brandIds.length) for (const b of await many<{ id: string; name: string }>(db, `SELECT id, name FROM brands WHERE id = ANY($1::uuid[])`, [brandIds])) names.set(b.id, b.name);
  if (connIds.length) for (const c of await many<{ id: string; name: string }>(db, `SELECT id, display_name AS name FROM connections WHERE id = ANY($1::uuid[])`, [connIds])) names.set(c.id, c.name);
  const teams = teamIds.length ? await many<{ id: string; name: string }>(db, `SELECT id, name FROM teams WHERE id = ANY($1::uuid[])`, [teamIds]) : [];
  return rows.map((r) => ({
    id: r.id, email: r.email, role: r.role, brand_ids: r.brand_ids, expires_at: r.expires_at.toISOString(), created_at: r.created_at.toISOString(),
    invited_by_email: r.invited_by_email, status: r.expires_at.getTime() <= Date.now() ? 'expired' : 'pending',
    kind: r.kind, access_expires_at: r.access_expires_at?.toISOString() ?? null, resent_count: r.resent_count, last_sent_at: r.last_sent_at?.toISOString() ?? null,
    grants: r.grants.map((g) => ({ ...g, brand_name: g.brand_id ? names.get(g.brand_id) ?? null : null, connection_name: g.connection_id ? names.get(g.connection_id) ?? null : null })),
    teams: r.team_ids.map((id) => teams.find((t) => t.id === id)).filter((t): t is { id: string; name: string } => !!t),
  }));
}

export const acceptUrl = (token: string) => `${config().APP_BASE_URL.replace(/\/$/, '')}/invite/${encodeURIComponent(token)}`;

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

/** Open (not accepted, not revoked) invitations, including expired ones so they can be re-sent/revoked. */
export async function listInvitations(ctx: Ctx, db: Queryable = getPool()): Promise<InvitationDto[]> {
  if (!canAnywhere(ctx, 'members.invite')) return [];
  const rows = await many<InvitationRow>(db,
    `${INV_SELECT} WHERE i.workspace_id=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL ORDER BY i.created_at DESC LIMIT 500`, [ctx.access.workspaceId]);
  return toDtos(db, rows);
}

export interface CreateInvitationInput {
  email: string;
  /** V1 shape: role + optional brand_ids ⇒ one grant per brand (or a workspace grant). */
  role?: string; brand_ids?: string[];
  /** V2 shape: explicit scoped grants (role + brand_id/connection_id + optional expiry). */
  grants?: GrantInput[];
  team_ids?: string[];
  /** Guests: required access expiry (defaults to the workspace guest_default_days). */
  access_expires_at?: string | null;
}
export type CreateInvitationResult = InvitationDto & { accept_url?: string; email_sent: boolean };

function grantInputs(input: CreateInvitationInput): GrantInput[] {
  if (input.grants?.length) return input.grants;
  if (!input.role) throw new AppError('validation_failed', 'Choose a role', { role: 'Required' });
  const brands = [...new Set(input.brand_ids ?? [])];
  if (brands.some((b) => !isUuid(b))) throw new AppError('validation_failed', 'Unknown brand', { brand_ids: 'Unknown brand' });
  if (brands.length && input.role === 'admin') throw new AppError('validation_failed', 'Admins always have access to every brand', { brand_ids: 'Brand restrictions do not apply to admins' });
  return brands.length ? brands.map((b) => ({ role: input.role!, brand_id: b })) : [{ role: input.role }];
}

interface Prepared { email: string; grants: NormalizedGrant[]; teamIds: string[]; kind: 'member' | 'guest'; accessExpiresAt: Date | null; summary: { role: Role; brandIds: string[] } }

/** Validate one invitation request against the caller's authority (no writes). */
async function prepare(tx: Queryable, ctx: Ctx, input: CreateInvitationInput): Promise<Prepared> {
  const email = (input.email ?? '').trim();
  if (!EMAIL_RE.test(email) || email.length > 320) throw new AppError('validation_failed', 'Enter a valid email address', { email: 'Enter a valid email address' });
  if (input.role === 'owner' || input.grants?.some((g) => g.role === 'owner')) {
    throw new AppError('validation_failed', 'Invite as admin, then transfer ownership', { role: 'Owners cannot be invited directly' });
  }
  const raw = grantInputs(input);
  const isGuest = raw.some((g) => g.role === 'guest');
  if (isGuest && raw.some((g) => g.role !== 'guest')) throw new AppError('validation_failed', 'A guest invitation can only carry guest access', { grants: 'Guest only' });
  const policy = await workspacePolicy(tx, ctx.access.workspaceId);
  let accessExpiresAt: Date | null = null;
  if (isGuest) {
    accessExpiresAt = input.access_expires_at ? new Date(input.access_expires_at) : new Date(Date.now() + policy.guest_default_days * 86400_000);
    if (Number.isNaN(accessExpiresAt.getTime()) || accessExpiresAt.getTime() <= Date.now() + 3600_000) {
      throw new AppError('validation_failed', 'Guest access must end in the future', { access_expires_at: 'Choose a later date' });
    }
    if (accessExpiresAt.getTime() > Date.now() + policy.guest_max_days * 86400_000 + 60_000) {
      throw new AppError('validation_failed', `Guest access can last at most ${policy.guest_max_days} days`, { access_expires_at: `At most ${policy.guest_max_days} days` });
    }
  }
  const grants = await normalizeGrants(tx, ctx.access.workspaceId, raw.map((g) => ({ ...g, expires_at: isGuest ? accessExpiresAt!.toISOString() : g.expires_at })),
    { allowed: GRANTABLE_ROLES.filter((r) => r !== 'team_manager'), guestExpiry: accessExpiresAt });
  assertDelegable(ctx, grants);
  if (needsStepUp(grants)) requireAction(ctx, 'members.invite', { stepUp: true });
  const teamIds = [...new Set(input.team_ids ?? [])];
  if (teamIds.length) {
    if (isGuest) throw new AppError('validation_failed', 'Guests cannot join teams', { team_ids: 'Not for guests' });
    if (teamIds.some((t) => !isUuid(t))) throw new AppError('validation_failed', 'Unknown team', { team_ids: 'Unknown team' });
    const teams = await many<{ id: string }>(tx, `SELECT id FROM teams WHERE workspace_id=$1 AND id = ANY($2::uuid[]) AND archived_at IS NULL`, [ctx.access.workspaceId, teamIds]);
    if (teams.length !== teamIds.length) throw new AppError('validation_failed', 'Unknown team', { team_ids: 'Unknown team' });
    // Joining a team is a privilege grant: the inviter must be able to delegate every team grant.
    const tg = await many<{ role: RolePreset; brand_id: string | null; connection_id: string | null }>(tx,
      `SELECT role, brand_id, connection_id FROM scoped_role_grants WHERE workspace_id=$1 AND team_id = ANY($2::uuid[]) AND revoked_at IS NULL`, [ctx.access.workspaceId, teamIds]);
    if (tg.some((g) => !mayDelegate(ctx, { role: g.role, brandId: g.brand_id, connectionId: g.connection_id }))) {
      throw new AppError('forbidden', 'You cannot add people to a team whose access you could not grant yourself.');
    }
  }
  const s = legacySummary(grants.map((g) => ({ role: g.role, scope_type: g.scopeType, brand_id: g.brandId })));
  return { email, grants, teamIds, kind: isGuest ? 'guest' : 'member', accessExpiresAt, summary: { role: s.role === 'owner' ? 'admin' : s.role, brandIds: s.restricted ? s.brandIds : [] } };
}

/** Insert one invitation (inside the caller's transaction). Returns the row and the one-time token. */
async function insertInvitation(tx: Queryable, ctx: Ctx, p: Prepared, batchId: string | null): Promise<{ inv: InvitationRow; token: string }> {
  const member = await maybeOne<{ user_id: string; status: string }>(tx,
    `SELECT m.user_id, m.status FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND u.email=$2 AND m.removed_at IS NULL AND m.status <> 'removed'`,
    [ctx.access.workspaceId, p.email]);
  if (member) throw new AppError('conflict', 'This person is already a member of the workspace.', undefined, { reason: 'already_member' });
  const open = await maybeOne<{ id: string; expires_at: Date }>(tx,
    `SELECT id, expires_at FROM invitations WHERE workspace_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE`, [ctx.access.workspaceId, p.email]);
  if (open) {
    if (open.expires_at.getTime() > Date.now()) throw new AppError('conflict', 'An invitation for this email is already pending. Resend or revoke it.', undefined, { reason: 'already_invited', invitation_id: open.id });
    await tx.query(`UPDATE invitations SET revoked_at=now(), revoked_by=$2 WHERE id=$1`, [open.id, ctx.actor.userId]); // replace expired invitation
  }
  const policy = await workspacePolicy(tx, ctx.access.workspaceId);
  const token = randomToken(32);
  const stored: StoredGrant[] = p.grants.map((g) => ({ role: g.role, scope_type: g.scopeType, brand_id: g.brandId, connection_id: g.connectionId }));
  const row = await maybeOne<{ id: string }>(tx,
    `INSERT INTO invitations(workspace_id, email, role, brand_ids, token_hash, invited_by, expires_at, grants, team_ids, kind, access_expires_at, last_sent_at, batch_id)
     VALUES ($1,$2,$3,$4::uuid[],$5,$6,now() + make_interval(hours => $7::int),$8,$9::uuid[],$10,$11,now(),$12) RETURNING id`,
    [ctx.access.workspaceId, p.email, p.summary.role, p.summary.brandIds, sha256(token), ctx.actor.userId, policy.invite_ttl_hours, JSON.stringify(stored),
      p.teamIds, p.kind, p.accessExpiresAt, batchId]);
  const inv = (await maybeOne<InvitationRow>(tx, `${INV_SELECT} WHERE i.id=$1`, [row!.id]))!;
  await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'invitation.created', resourceType: 'invitation', resourceId: inv.id,
    diff: { email: p.email, kind: p.kind, grants: stored, team_ids: p.teamIds, access_expires_at: p.accessExpiresAt?.toISOString() ?? null, expires_at: inv.expires_at.toISOString(), batch_id: batchId },
    correlationId: ctx.correlationId });
  return { inv, token };
}

async function sendInvite(ctx: Ctx, inv: InvitationRow, token: string): Promise<boolean> {
  const ws = await maybeOne<{ name: string }>(getPool(), `SELECT name FROM workspaces WHERE id=$1`, [inv.workspace_id]);
  const role = inv.kind === 'guest' ? 'guest reviewer' : inv.role;
  return sendMail(invitationEmail({ to: inv.email, workspaceName: ws?.name ?? 'a workspace', inviterEmail: ctx.actor.email, role, acceptUrl: acceptUrl(token), expiresAt: inv.expires_at }));
}

export async function createInvitation(ctx: Ctx, input: CreateInvitationInput, idempotencyKey: string | null): Promise<{ status: number; body: CreateInvitationResult }> {
  requireAction(ctx, 'members.invite');
  const result = await withTx(async (tx) => {
    const replay = await beginIdempotent(tx, { workspaceId: ctx.access.workspaceId, userId: ctx.actor.userId, action: 'invitations.create', key: idempotencyKey, body: input });
    if (replay) return { replay: replay as { status: number; body: CreateInvitationResult } };
    const p = await prepare(tx, ctx, input);
    const { inv, token } = await insertInvitation(tx, ctx, p, null);
    // The stored idempotent response deliberately omits the token-bearing accept_url.
    const stored: CreateInvitationResult = { ...(await toDtos(tx, [inv]))[0]!, email_sent: false };
    await completeIdempotent(tx, { workspaceId: ctx.access.workspaceId, action: 'invitations.create', key: idempotencyKey!, status: 201, body: stored });
    return { inv, token, stored };
  });
  if ('replay' in result) return result.replay!;
  // Send synchronously AFTER commit (never inside the transaction).
  const sent = await sendInvite(ctx, result.inv, result.token);
  if (sent) {
    await getPool().query(
      `UPDATE idempotency_keys SET response_body = jsonb_set(response_body, '{email_sent}', 'true') WHERE workspace_id=$1 AND action='invitations.create' AND key=$2`,
      [ctx.access.workspaceId, idempotencyKey]);
  }
  return { status: 201, body: { ...result.stored, accept_url: acceptUrl(result.token), email_sent: sent } };
}

export interface BulkRowResult {
  row: number; email: string; status: 'invited' | 'already_member' | 'already_invited' | 'duplicate' | 'error';
  invitation_id?: string; code?: string; message?: string; email_sent?: boolean; accept_url?: string;
}

/**
 * Bulk invite: each row validated and created independently (savepoint per row) with a per-row result.
 * Duplicate resistance: repeated emails in one batch, existing members and pending invitations are
 * reported, not re-created; the whole batch is idempotent by key (replays never re-send or re-disclose tokens).
 */
export async function bulkInvite(ctx: Ctx, input: { rows: CreateInvitationInput[] }, idempotencyKey: string | null): Promise<{ batch_id: string; results: BulkRowResult[]; replayed: boolean }> {
  requireAction(ctx, 'members.invite');
  const rows = Array.isArray(input.rows) ? input.rows : [];
  if (!rows.length || rows.length > 100) throw new AppError('validation_failed', 'Add between 1 and 100 rows', { rows: '1-100 rows' });
  const toSend: Array<{ inv: InvitationRow; token: string; idx: number }> = [];
  const out = await withTx(async (tx) => {
    const replay = await beginIdempotent(tx, { workspaceId: ctx.access.workspaceId, userId: ctx.actor.userId, action: 'invitations.bulk', key: idempotencyKey, body: input });
    if (replay) return { replay: replay.body as { batch_id: string; results: BulkRowResult[] } };
    const batch = (await maybeOne<{ id: string }>(tx, `SELECT gen_random_uuid() AS id`))!.id;
    const seen = new Set<string>();
    const results: BulkRowResult[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const email = String(r.email ?? '').trim();
      const key = email.toLowerCase();
      if (seen.has(key)) { results.push({ row: i + 1, email, status: 'duplicate', message: 'Same email earlier in this list' }); continue; }
      seen.add(key);
      await tx.query('SAVEPOINT bulk_row');
      try {
        const p = await prepare(tx, ctx, r);
        const { inv, token } = await insertInvitation(tx, ctx, p, batch);
        await tx.query('RELEASE SAVEPOINT bulk_row');
        results.push({ row: i + 1, email: p.email, status: 'invited', invitation_id: inv.id });
        toSend.push({ inv, token, idx: results.length - 1 });
      } catch (err) {
        await tx.query('ROLLBACK TO SAVEPOINT bulk_row');
        const e = err as AppError;
        const reason = (e.details as { reason?: string } | undefined)?.reason;
        if (reason === 'already_member') results.push({ row: i + 1, email, status: 'already_member', message: e.message });
        else if (reason === 'already_invited') results.push({ row: i + 1, email, status: 'already_invited', message: e.message });
        else if (e instanceof AppError) results.push({ row: i + 1, email, status: 'error', code: e.code, message: e.message });
        else throw err;
      }
    }
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'invitation.bulk', resourceType: 'invitation_batch', resourceId: batch,
      diff: { rows: rows.length, invited: results.filter((x) => x.status === 'invited').length }, correlationId: ctx.correlationId });
    const body = { batch_id: batch, results };
    await completeIdempotent(tx, { workspaceId: ctx.access.workspaceId, action: 'invitations.bulk', key: idempotencyKey!, status: 200, body });
    return { body };
  });
  if ('replay' in out) return { ...out.replay!, replayed: true };
  const results = out.body.results.map((r) => ({ ...r }));
  for (const s of toSend) {
    const sent = await sendInvite(ctx, s.inv, s.token).catch(() => false);
    results[s.idx] = { ...results[s.idx]!, email_sent: sent, accept_url: acceptUrl(s.token) };
  }
  return { batch_id: out.body.batch_id, results, replayed: false };
}

/** Resend: rotates the token (old link stops working immediately), restarts the expiry, emails again. */
export async function resendInvitation(ctx: Ctx, invitationId: string): Promise<CreateInvitationResult> {
  requireAction(ctx, 'members.invite');
  assertUuid(invitationId, 'Invitation');
  const token = randomToken(32);
  const inv = await withTx(async (tx) => {
    const r = await maybeOne<InvitationRow>(tx, `${INV_SELECT} WHERE i.id=$1 AND i.workspace_id=$2 FOR UPDATE OF i`, [invitationId, ctx.access.workspaceId]);
    if (!r) throw notFound('Invitation');
    if (r.accepted_at) throw new AppError('invalid_state', 'This invitation was already accepted.');
    if (r.revoked_at) throw new AppError('invalid_state', 'This invitation was revoked. Create a new one.');
    // The resender must be able to delegate what the invitation carries.
    assertDelegable(ctx, r.grants.map((g) => ({ role: g.role, brandId: g.brand_id, connectionId: g.connection_id })));
    if (r.kind === 'guest' && r.access_expires_at && r.access_expires_at.getTime() <= Date.now() + 3600_000) {
      throw new AppError('invalid_state', 'The guest access period has ended. Create a new invitation.');
    }
    const policy = await workspacePolicy(tx, ctx.access.workspaceId);
    await tx.query(
      `UPDATE invitations SET token_hash=$2, expires_at=now() + make_interval(hours => $3::int), resent_count=resent_count+1, last_sent_at=now() WHERE id=$1`,
      [r.id, sha256(token), policy.invite_ttl_hours]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'invitation.resent', resourceType: 'invitation', resourceId: r.id,
      diff: { email: r.email, resent_count: r.resent_count + 1 }, correlationId: ctx.correlationId });
    return (await maybeOne<InvitationRow>(tx, `${INV_SELECT} WHERE i.id=$1`, [r.id]))!;
  });
  const sent = await sendInvite(ctx, inv, token);
  return { ...(await toDtos(getPool(), [inv]))[0]!, accept_url: acceptUrl(token), email_sent: sent };
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
    await tx.query(`UPDATE invitations SET revoked_at=now(), revoked_by=$2 WHERE id=$1`, [r.id, ctx.actor.userId]);
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

/** Public preview for the invite landing page. Reveals only a masked email; never whether an account exists. */
export async function previewInvitation(token: string, db: Queryable = getPool()): Promise<{ workspace_name: string; email_hint: string; role: Role; kind: 'member' | 'guest'; expires_at: string; status: InvitationStatus }> {
  if (!token || token.length > 200) throw notFound('Invitation');
  const r = await maybeOne<{ name: string; email: string; role: Role; kind: 'member' | 'guest'; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null }>(db,
    `SELECT w.name, i.email, i.role, i.kind, i.expires_at, i.accepted_at, i.revoked_at
       FROM invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE i.token_hash=$1`, [sha256(token)]);
  if (!r) throw notFound('Invitation');
  const status: InvitationStatus = r.accepted_at ? 'accepted' : r.revoked_at ? 'revoked' : r.expires_at.getTime() <= Date.now() ? 'expired' : 'pending';
  return { workspace_name: r.name, email_hint: maskEmail(r.email), role: r.role, kind: r.kind, expires_at: r.expires_at.toISOString(), status };
}

/**
 * Accept an invitation for an authenticated user. `user.email` must be the email VERIFIED by the identity
 * provider for this user; the user row must be bound to a real (issuer, subject) identity with a verified
 * email equal to the invited address (case-insensitive). Single use; atomic under concurrency (row lock).
 * Must run inside a transaction. Throws LoginError with a stable code.
 */
export async function acceptInvitation(tx: Queryable, tokenHash: Buffer, user: { id: string; email: string }): Promise<{ workspaceId: string; alreadyMember: boolean }> {
  const inv = await maybeOne<InvitationRow & { state: string }>(tx,
    `SELECT i.*, NULL::text AS invited_by_email, w.state
       FROM invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE i.token_hash=$1 FOR UPDATE OF i`, [tokenHash]);
  if (!inv) throw new LoginError('invitation_invalid', 'This invitation link is not valid.');
  if (inv.accepted_at) throw new LoginError('invitation_used', 'This invitation has already been used.');
  if (inv.revoked_at) throw new LoginError('invitation_revoked', 'This invitation was revoked. Ask for a new one.');
  if (inv.expires_at.getTime() <= Date.now()) throw new LoginError('invitation_expired', 'This invitation has expired. Ask for a new one.');
  if (inv.state !== 'active') throw new LoginError('invitation_invalid', 'This workspace is not available.');
  const identity = await maybeOne<{ email: string; email_verified: boolean; oidc_issuer: string; oidc_subject: string; disabled_at: Date | null }>(tx,
    `SELECT email, email_verified, oidc_issuer, oidc_subject, disabled_at FROM users WHERE id=$1`, [user.id]);
  const invited = inv.email.toLowerCase();
  if (!identity || identity.disabled_at || !identity.email_verified || identity.oidc_issuer === PENDING_ISSUER
      || identity.email.toLowerCase() !== invited || user.email.trim().toLowerCase() !== invited) {
    throw new LoginError('email_mismatch', 'This invitation was sent to a different email address. Sign in with the invited address.');
  }
  if (inv.kind === 'guest' && (!inv.access_expires_at || inv.access_expires_at.getTime() <= Date.now())) {
    throw new LoginError('invitation_expired', 'The guest access period for this invitation has ended. Ask for a new one.');
  }
  // The inviter must still be able to delegate everything the invitation carries (no stale authority).
  const inviter = await loadUserAuthz(inv.invited_by, inv.workspace_id, null, tx);
  const inviterCtx: Ctx = { actor: { userId: inv.invited_by, email: '', name: null, sessionId: '' }, correlationId: '',
    access: { workspaceId: inv.workspace_id, role: 'viewer', brandIds: null, isDemo: false, authz: inviter } };
  const inviterMayInvite = inviter.subject.status === 'active' && inviter.subject.grants.some((g) => g.scopeType === 'workspace' && ['owner', 'admin'].includes(g.role));
  if (!inviterMayInvite || inv.grants.some((g) => !mayDelegate(inviterCtx, { role: g.role, brandId: g.brand_id, connectionId: g.connection_id }))) {
    throw new LoginError('invitation_invalid', 'This invitation is no longer valid. Ask for a new one.');
  }

  const m = await maybeOne<{ status: string; removed_at: Date | null }>(tx,
    `SELECT status, removed_at FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE`, [inv.workspace_id, user.id]);
  if (m?.status === 'suspended') throw new LoginError('membership_suspended', 'Your access to this workspace is suspended. Contact the workspace owner.');
  const alreadyMember = !!m && m.status === 'active' && m.removed_at === null;
  if (!alreadyMember) {
    if (m) {
      await tx.query(
        `UPDATE memberships SET status='active', removed_at=NULL, removed_by=NULL, suspended_at=NULL, suspended_by=NULL, status_reason=NULL, created_at=now()
          WHERE workspace_id=$1 AND user_id=$2`, [inv.workspace_id, user.id]);
    } else {
      await tx.query(`INSERT INTO memberships(workspace_id, user_id, role, brand_restricted) VALUES ($1,$2,$3,$4)`, [inv.workspace_id, user.id, inv.role, inv.brand_ids.length > 0]);
    }
    await tx.query(`INSERT INTO membership_status_history(workspace_id, user_id, from_status, to_status, actor_user_id, reason) VALUES ($1,$2,$3,'active',$4,'invitation_accepted')`,
      [inv.workspace_id, user.id, m?.status ?? null, user.id]);
  }
  // Grants: re-validated now (brands/destinations that no longer exist are skipped; composite FKs enforce tenancy).
  let granted = 0;
  for (const g of inv.grants) {
    const ok = g.connection_id
      ? await maybeOne(tx, `SELECT 1 FROM connections WHERE id=$1 AND workspace_id=$2 AND brand_id=$3 AND disconnected_at IS NULL`, [g.connection_id, inv.workspace_id, g.brand_id])
      : g.brand_id ? await maybeOne(tx, `SELECT 1 FROM brands WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [g.brand_id, inv.workspace_id]) : true;
    if (!ok) continue;
    await upsertGrant(tx, { workspaceId: inv.workspace_id, principal: { userId: user.id }, grantedBy: inv.invited_by, source: 'invitation',
      grant: { role: g.role, scopeType: g.scope_type, brandId: g.brand_id, connectionId: g.connection_id, expiresAt: inv.kind === 'guest' ? inv.access_expires_at : null } });
    granted++;
  }
  // Legacy V1 invitation rows (no grants column content): role + brand_ids.
  if (!inv.grants.length) {
    const brands = inv.brand_ids.length ? await many<{ id: string }>(tx, `SELECT id FROM brands WHERE workspace_id=$1 AND id = ANY($2::uuid[])`, [inv.workspace_id, inv.brand_ids]) : [];
    const legacy: NormalizedGrant[] = inv.brand_ids.length
      ? brands.map((b) => ({ role: inv.role as RolePreset, scopeType: 'brand', brandId: b.id, connectionId: null, expiresAt: null }))
      : [{ role: inv.role as RolePreset, scopeType: 'workspace', brandId: null, connectionId: null, expiresAt: null }];
    for (const g of legacy) { await upsertGrant(tx, { workspaceId: inv.workspace_id, principal: { userId: user.id }, grantedBy: inv.invited_by, source: 'invitation', grant: g }); granted++; }
  }
  if (inv.team_ids.length) {
    await tx.query(
      `INSERT INTO team_memberships(workspace_id, team_id, user_id, added_by)
       SELECT $1, t.id, $2, $3 FROM teams t WHERE t.workspace_id=$1 AND t.id = ANY($4::uuid[]) AND t.archived_at IS NULL ON CONFLICT DO NOTHING`,
      [inv.workspace_id, user.id, inv.invited_by, inv.team_ids]);
  }
  await tx.query(`UPDATE invitations SET accepted_at=now(), accepted_by=$2, accepted_issuer=$3, accepted_subject=$4 WHERE id=$1`,
    [inv.id, user.id, identity.oidc_issuer, identity.oidc_subject]);
  const pc = await commitPolicyChange(tx, inv.workspace_id, [user.id]);
  await audit(tx, { workspaceId: inv.workspace_id, actorUserId: user.id, action: 'invitation.accepted', resourceType: 'invitation', resourceId: inv.id,
    diff: { kind: inv.kind, grants: granted, team_ids: inv.team_ids, already_member: alreadyMember, policy_version: pc.policyVersion } });
  return { workspaceId: inv.workspace_id, alreadyMember };
}

/**
 * Accept from an existing signed-in session (joining another workspace): the session's user is the
 * identity; their stored email was verified by the identity provider at sign-in. Never links accounts.
 */
export async function acceptInvitationForUser(userId: string, token: string, db = getPool()): Promise<{ workspaceId: string; alreadyMember: boolean }> {
  if (!token || token.length > 200) throw new LoginError('invitation_invalid', 'This invitation link is not valid.');
  const u = await maybeOne<{ email: string }>(db, `SELECT email FROM users WHERE id=$1 AND email_verified`, [userId]);
  if (!u) throw new LoginError('email_mismatch', 'Sign in with the invited address.');
  return withTx((tx) => acceptInvitation(tx, sha256(token), { id: userId, email: u.email }), db);
}
