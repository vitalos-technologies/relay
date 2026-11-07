// Service accounts + API keys (V2 §8). Workspace-owned, brand-scoped machine principals with a named human
// owner, optional expiry, explicit grants (integration / viewer / editor on ONE brand by default) and keys.
//  - Keys: `sl_live_<prefix>_<secret>`; shown ONCE; only sha256(key) is stored with the non-secret prefix for lookup.
//  - Revocation and expiry take effect on the next request (no caching); disabled/expired accounts are denied by
//    the central policy (authz.ts → evaluate: 'disabled').
//  - Create / new key / rotate require owner/admin (service_accounts.manage) with fresh MFA (step-up).
//  - Every change bumps the workspace policy version (grant changes) and is audited with the key PREFIX only.
//  - Authentication of machine requests: authenticateApiKey(Authorization header) → serviceAccountCtx().
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError, notFound } from '@social-lite/core';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from './context.js';
import { audit } from './audit.js';
import { bumpPolicyVersion, loadServiceAccountAuthz, brandsVisible } from './authz.js';
import { assertUuid, requireAction } from './tenancy.js';

export const API_KEY_RE = /^sl_live_([a-z0-9]{12})_([a-f0-9]{64})$/;
export const SERVICE_ACCOUNT_ROLES = ['integration', 'viewer', 'editor'] as const;
const MAX_KEYS_PER_ACCOUNT = 5;
const LAST_USED_RESOLUTION_MS = 60_000;

const keyHash = (key: string) => createHash('sha256').update(key, 'utf8').digest();

function newKey(): { key: string; prefix: string } {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const rnd = randomBytes(12);
  const p = [...rnd].map((b) => alphabet[b % alphabet.length]).join('');
  const prefix = `sl_live_${p}`;
  return { key: `${prefix}_${randomBytes(32).toString('hex')}`, prefix };
}

/** Never log or return a full key: this is the only representation used outside creation. */
export function redactKey(key: string): string {
  const m = /^(sl_live_[a-z0-9]{12})_/.exec(key);
  return m ? `${m[1]}_…` : '[redacted]';
}

export const createServiceAccountSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).nullish(),
  owner_user_id: z.string().uuid().nullish(),
  brand_id: z.string().uuid(),
  role: z.enum(SERVICE_ACCOUNT_ROLES).default('integration'),
  expires_at: z.string().datetime({ offset: true }).nullish(),
  key_expires_at: z.string().datetime({ offset: true }).nullish(),
}).strict();

export const newKeySchema = z.object({ label: z.string().trim().max(60).nullish(), expires_at: z.string().datetime({ offset: true }).nullish() }).strict();

interface SaRow { id: string; workspace_id: string; name: string; description: string | null; owner_user_id: string; expires_at: Date | null; disabled_at: Date | null;
  last_used_at: Date | null; created_at: Date; purpose: string }

function futureOrNull(iso: string | null | undefined, field: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (d.getTime() <= Date.now() + 60_000) throw new AppError('validation_failed', 'Expiry must be in the future', { [field]: 'Choose a future date' });
  if (d.getTime() > Date.now() + 366 * 86_400_000) throw new AppError('validation_failed', 'Expiry can be at most one year away', { [field]: 'At most one year' });
  return d;
}

async function insertKey(tx: Queryable, ctx: Ctx, sa: { id: string }, opts: { label?: string | null; expiresAt: Date | null; rotatedFrom?: string | null }) {
  const live = await one<{ n: number }>(tx, `SELECT count(*)::int n FROM api_key_hashes WHERE service_account_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [sa.id]);
  if (live.n >= MAX_KEYS_PER_ACCOUNT) throw new AppError('conflict', `At most ${MAX_KEYS_PER_ACCOUNT} active keys per service account. Revoke one first.`);
  const { key, prefix } = newKey();
  const row = await one<{ id: string; created_at: Date }>(tx,
    `INSERT INTO api_key_hashes(workspace_id, service_account_id, prefix, key_hash, created_by, expires_at, label, rotated_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
    [ctx.access.workspaceId, sa.id, prefix, keyHash(key), ctx.actor.userId, opts.expiresAt, opts.label ?? null, opts.rotatedFrom ?? null]);
  return { id: row.id, prefix, key, created_at: row.created_at.toISOString(), expires_at: opts.expiresAt?.toISOString() ?? null };
}

/** Create a service account with ONE scoped grant and its first key (returned once). */
export async function createServiceAccount(ctx: Ctx, raw: unknown, idemKey?: string | null) {
  requireAction(ctx, 'service_accounts.manage', { stepUp: true });
  const input = createServiceAccountSchema.parse(raw);
  // Grant scope is re-checked: the creator must themselves be able to act on the brand.
  requireAction(ctx, 'brands.read', { brandId: input.brand_id });
  const expiresAt = futureOrNull(input.expires_at, 'expires_at');
  const keyExpiresAt = futureOrNull(input.key_expires_at, 'key_expires_at') ?? expiresAt;
  return withTx(async (tx) => {
    const brand = await maybeOne<{ id: string; archived_at: Date | null }>(tx, `SELECT id, archived_at FROM brands WHERE id=$1 AND workspace_id=$2`, [input.brand_id, ctx.access.workspaceId]);
    if (!brand || brand.archived_at) throw notFound('Brand');
    const ownerId = input.owner_user_id ?? ctx.actor.userId;
    const owner = await maybeOne(tx, `SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.status='active' AND u.disabled_at IS NULL`,
      [ctx.access.workspaceId, ownerId]);
    if (!owner) throw new AppError('validation_failed', 'The owner must be an active member', { owner_user_id: 'Choose an active member' });
    const clash = await maybeOne(tx, `SELECT 1 FROM service_accounts WHERE workspace_id=$1 AND lower(name)=lower($2) AND disabled_at IS NULL`, [ctx.access.workspaceId, input.name]);
    if (clash) throw new AppError('conflict', 'A service account with this name already exists', { name: 'Choose another name' });
    const sa = await one<{ id: string }>(tx,
      `INSERT INTO service_accounts(workspace_id, name, description, owner_user_id, expires_at, created_by, purpose) VALUES ($1,$2,$3,$4,$5,$6,'api') RETURNING id`,
      [ctx.access.workspaceId, input.name, input.description ?? null, ownerId, expiresAt, ctx.actor.userId]);
    await tx.query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, service_account_id, role, scope_type, brand_id, granted_by, source)
                    VALUES ($1,'service_account',$2,$3,'brand',$4,$5,'manual')`, [ctx.access.workspaceId, sa.id, input.role, input.brand_id, ctx.actor.userId]);
    const key = await insertKey(tx, ctx, sa, { label: 'Initial key', expiresAt: keyExpiresAt });
    const policyVersion = await bumpPolicyVersion(tx, ctx.access.workspaceId);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: input.brand_id, actorUserId: ctx.actor.userId, action: 'service_account.created',
      resourceType: 'service_account', resourceId: sa.id, correlationId: ctx.correlationId,
      diff: { after: { name: input.name, owner_user_id: ownerId, role: input.role, brand_id: input.brand_id, expires_at: expiresAt?.toISOString() ?? null }, key_prefix: key.prefix, policy_version: policyVersion, idempotency: idemKey ? 'present' : 'absent' } });
    return { service_account: await viewOne(tx, ctx, sa.id), key: { id: key.id, prefix: key.prefix, secret: key.key, expires_at: key.expires_at } };
  });
}

export async function issueKey(ctx: Ctx, serviceAccountId: string, raw: unknown) {
  requireAction(ctx, 'service_accounts.manage', { stepUp: true });
  assertUuid(serviceAccountId, 'Service account');
  const input = newKeySchema.parse(raw ?? {});
  return withTx(async (tx) => {
    const sa = await lockAccount(tx, ctx, serviceAccountId);
    if (sa.disabled_at) throw new AppError('invalid_state', 'This service account is disabled');
    const expiresAt = futureOrNull(input.expires_at, 'expires_at') ?? sa.expires_at;
    const key = await insertKey(tx, ctx, sa, { label: input.label ?? null, expiresAt });
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'service_account.key_created', resourceType: 'service_account', resourceId: sa.id,
      correlationId: ctx.correlationId, diff: { key_prefix: key.prefix, expires_at: key.expires_at } });
    return { key: { id: key.id, prefix: key.prefix, secret: key.key, expires_at: key.expires_at } };
  });
}

/** Rotate: issue a replacement key and revoke the old one immediately (attribution kept via rotated_from). */
export async function rotateKey(ctx: Ctx, serviceAccountId: string, keyId: string) {
  requireAction(ctx, 'service_accounts.manage', { stepUp: true });
  assertUuid(serviceAccountId, 'Service account');
  assertUuid(keyId, 'Key');
  return withTx(async (tx) => {
    const sa = await lockAccount(tx, ctx, serviceAccountId);
    if (sa.disabled_at) throw new AppError('invalid_state', 'This service account is disabled');
    const old = await maybeOne<{ id: string; prefix: string; label: string | null; expires_at: Date | null }>(tx,
      `UPDATE api_key_hashes SET revoked_at=now(), revoked_by=$4, revoked_reason='rotated' WHERE id=$1 AND service_account_id=$2 AND workspace_id=$3 AND revoked_at IS NULL
       RETURNING id, prefix, label, expires_at`, [keyId, sa.id, ctx.access.workspaceId, ctx.actor.userId]);
    if (!old) throw notFound('Key');
    const key = await insertKey(tx, ctx, sa, { label: old.label, expiresAt: old.expires_at && old.expires_at.getTime() > Date.now() ? old.expires_at : sa.expires_at, rotatedFrom: old.id });
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'service_account.key_rotated', resourceType: 'service_account', resourceId: sa.id,
      correlationId: ctx.correlationId, diff: { old_prefix: old.prefix, new_prefix: key.prefix } });
    return { key: { id: key.id, prefix: key.prefix, secret: key.key, expires_at: key.expires_at } };
  });
}

/** Revoke a key immediately. Needs service_accounts.manage (MFA) but not step-up: removing access is always allowed. */
export async function revokeKey(ctx: Ctx, serviceAccountId: string, keyId: string) {
  requireAction(ctx, 'service_accounts.manage');
  assertUuid(serviceAccountId, 'Service account');
  assertUuid(keyId, 'Key');
  return withTx(async (tx) => {
    const sa = await lockAccount(tx, ctx, serviceAccountId);
    const k = await maybeOne<{ prefix: string }>(tx,
      `UPDATE api_key_hashes SET revoked_at=now(), revoked_by=$4, revoked_reason='revoked' WHERE id=$1 AND service_account_id=$2 AND workspace_id=$3 AND revoked_at IS NULL RETURNING prefix`,
      [keyId, sa.id, ctx.access.workspaceId, ctx.actor.userId]);
    if (!k) throw notFound('Key');
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'service_account.key_revoked', resourceType: 'service_account', resourceId: sa.id,
      correlationId: ctx.correlationId, diff: { key_prefix: k.prefix } });
    return viewOne(tx, ctx, sa.id);
  });
}

/** Disable the account: every key stops working immediately and its grants no longer apply. */
export async function disableServiceAccount(ctx: Ctx, serviceAccountId: string) {
  requireAction(ctx, 'service_accounts.manage');
  assertUuid(serviceAccountId, 'Service account');
  return withTx(async (tx) => {
    const sa = await lockAccount(tx, ctx, serviceAccountId);
    if (sa.purpose === 'tipsignal') throw new AppError('invalid_state', 'Unbind TipSignal in Integrations instead');
    if (sa.disabled_at) return viewOne(tx, ctx, sa.id);
    await tx.query(`UPDATE service_accounts SET disabled_at=now(), disabled_by=$2 WHERE id=$1`, [sa.id, ctx.actor.userId]);
    const keys = await tx.query(`UPDATE api_key_hashes SET revoked_at=now(), revoked_by=$2, revoked_reason='account_disabled' WHERE service_account_id=$1 AND revoked_at IS NULL`, [sa.id, ctx.actor.userId]);
    await tx.query(`UPDATE scoped_role_grants SET revoked_at=now(), revoked_by=$2 WHERE service_account_id=$1 AND revoked_at IS NULL`, [sa.id, ctx.actor.userId]);
    const policyVersion = await bumpPolicyVersion(tx, ctx.access.workspaceId);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'service_account.disabled', resourceType: 'service_account', resourceId: sa.id,
      correlationId: ctx.correlationId, diff: { keys_revoked: keys.rowCount, policy_version: policyVersion } });
    return viewOne(tx, ctx, sa.id);
  });
}

async function lockAccount(tx: Queryable, ctx: Ctx, id: string): Promise<SaRow> {
  const sa = await maybeOne<SaRow>(tx, `SELECT * FROM service_accounts WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [id, ctx.access.workspaceId]);
  if (!sa) throw notFound('Service account');
  return sa;
}

export interface ServiceAccountView {
  id: string; name: string; description: string | null; purpose: string; status: 'active' | 'disabled' | 'expired';
  owner: { user_id: string; email: string; name: string | null };
  expires_at: string | null; last_used_at: string | null; created_at: string;
  grants: Array<{ id: string; role: string; brand_id: string | null; brand_name: string | null }>;
  keys: Array<{ id: string; prefix: string; label: string | null; created_at: string; expires_at: string | null; revoked_at: string | null; last_used_at: string | null; status: 'active' | 'revoked' | 'expired' }>;
}

async function views(db: Queryable, workspaceId: string, ids?: string[]): Promise<ServiceAccountView[]> {
  const rows = await many<SaRow & { email: string; owner_name: string | null }>(db,
    `SELECT sa.*, u.email, u.name AS owner_name FROM service_accounts sa JOIN users u ON u.id=sa.owner_user_id
      WHERE sa.workspace_id=$1 ${ids ? 'AND sa.id = ANY($2::uuid[])' : ''} ORDER BY sa.disabled_at NULLS FIRST, sa.created_at DESC`, ids ? [workspaceId, ids] : [workspaceId]);
  if (!rows.length) return [];
  const all = rows.map((r) => r.id);
  const grants = await many<{ id: string; service_account_id: string; role: string; brand_id: string | null; brand_name: string | null }>(db,
    `SELECT g.id, g.service_account_id, g.role, g.brand_id, b.name AS brand_name FROM scoped_role_grants g LEFT JOIN brands b ON b.id=g.brand_id
      WHERE g.workspace_id=$1 AND g.service_account_id = ANY($2::uuid[]) AND g.revoked_at IS NULL`, [workspaceId, all]);
  const keys = await many<{ id: string; service_account_id: string; prefix: string; label: string | null; created_at: Date; expires_at: Date | null; revoked_at: Date | null; last_used_at: Date | null }>(db,
    `SELECT id, service_account_id, prefix, label, created_at, expires_at, revoked_at, last_used_at FROM api_key_hashes
      WHERE workspace_id=$1 AND service_account_id = ANY($2::uuid[]) ORDER BY created_at DESC`, [workspaceId, all]);
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id, name: r.name, description: r.description, purpose: r.purpose,
    status: r.disabled_at ? 'disabled' : r.expires_at && r.expires_at.getTime() <= now ? 'expired' : 'active',
    owner: { user_id: r.owner_user_id, email: r.email, name: r.owner_name },
    expires_at: r.expires_at?.toISOString() ?? null, last_used_at: r.last_used_at?.toISOString() ?? null, created_at: r.created_at.toISOString(),
    grants: grants.filter((g) => g.service_account_id === r.id).map((g) => ({ id: g.id, role: g.role, brand_id: g.brand_id, brand_name: g.brand_name })),
    keys: keys.filter((k) => k.service_account_id === r.id).map((k) => ({
      id: k.id, prefix: k.prefix, label: k.label, created_at: k.created_at.toISOString(), expires_at: k.expires_at?.toISOString() ?? null,
      revoked_at: k.revoked_at?.toISOString() ?? null, last_used_at: k.last_used_at?.toISOString() ?? null,
      status: k.revoked_at ? 'revoked' : k.expires_at && k.expires_at.getTime() <= now ? 'expired' : 'active',
    })),
  }));
}

async function viewOne(db: Queryable, ctx: Ctx, id: string): Promise<ServiceAccountView> {
  const v = (await views(db, ctx.access.workspaceId, [id]))[0];
  if (!v) throw notFound('Service account');
  return v;
}

export async function listServiceAccounts(ctx: Ctx) {
  requireAction(ctx, 'service_accounts.manage');
  const db = getPool();
  const items = await views(db, ctx.access.workspaceId);
  const members = await many<{ user_id: string; email: string; name: string | null }>(db,
    `SELECT m.user_id, u.email, u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.status='active' AND u.disabled_at IS NULL ORDER BY u.email`,
    [ctx.access.workspaceId]);
  const brands = await many<{ id: string; name: string }>(db, `SELECT id, name FROM brands WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY name`, [ctx.access.workspaceId]);
  return { items, members, brands, roles: SERVICE_ACCOUNT_ROLES };
}

// ------------------------------------------------------------------ machine authentication

export interface ApiKeyPrincipal { serviceAccountId: string; workspaceId: string; keyId: string; prefix: string; name: string }

/**
 * Resolve `Authorization: Bearer sl_live_…`. Fails closed (null) for malformed, unknown, revoked or expired keys
 * and for disabled/expired accounts — checked against the database on every request.
 */
export async function authenticateApiKey(authorization: string | null | undefined, db: Queryable = getPool()): Promise<ApiKeyPrincipal | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!m || m[1]!.length > 120) return null;
  const key = m[1]!;
  const parts = API_KEY_RE.exec(key);
  if (!parts) return null;
  const prefix = `sl_live_${parts[1]}`;
  const row = await maybeOne<{ id: string; workspace_id: string; service_account_id: string; key_hash: Buffer; last_used_at: Date | null; name: string }>(db,
    `SELECT k.id, k.workspace_id, k.service_account_id, k.key_hash, k.last_used_at, sa.name
       FROM api_key_hashes k JOIN service_accounts sa ON sa.id=k.service_account_id AND sa.workspace_id=k.workspace_id
       JOIN workspaces w ON w.id=k.workspace_id AND w.state='active'
      WHERE k.prefix=$1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
        AND sa.disabled_at IS NULL AND (sa.expires_at IS NULL OR sa.expires_at > now())`, [prefix]);
  const presented = keyHash(key);
  // Constant-time comparison (also when the prefix is unknown, against a dummy hash).
  const stored = row?.key_hash ?? Buffer.alloc(32);
  if (!timingSafeEqual(stored, presented) || !row) return null;
  if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > LAST_USED_RESOLUTION_MS) {
    await db.query(`UPDATE api_key_hashes SET last_used_at=now() WHERE id=$1`, [row.id]);
    await db.query(`UPDATE service_accounts SET last_used_at=now() WHERE id=$1`, [row.service_account_id]);
  }
  return { serviceAccountId: row.service_account_id, workspaceId: row.workspace_id, keyId: row.id, prefix, name: row.name };
}

/**
 * Request context for a service-account principal (real policy path: loadServiceAccountAuthz).
 * actor.userId is empty: service-account writes record no human author; attribution is audit actor_service.
 */
export async function serviceAccountCtx(p: { serviceAccountId: string; workspaceId: string; name?: string; keyId?: string }, correlationId: string = randomUUID(), db: Queryable = getPool()): Promise<Ctx> {
  const authz = await loadServiceAccountAuthz(p.serviceAccountId, p.workspaceId, db);
  if (authz.subject.status !== 'active') throw new AppError('unauthenticated', 'Invalid or revoked API key');
  return {
    actor: { userId: '', email: `service-account:${p.serviceAccountId}`, name: p.name ?? 'Service account', sessionId: p.keyId ? `api-key:${p.keyId}` : 'service-account' },
    access: { workspaceId: p.workspaceId, role: 'viewer', brandIds: brandsVisible(authz), isDemo: false, authz },
    correlationId,
  };
}

export const serviceActor = (serviceAccountId: string) => `service_account:${serviceAccountId}`;
