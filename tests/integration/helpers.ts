// Shared integration-test helpers: real Postgres pool + tenant factories.
import { randomUUID } from 'node:crypto';
import { createPool, setPool, type Pool } from '@social-lite/db';
import type { Role } from '@social-lite/core';
import { resetConfigCache, type Ctx } from '@social-lite/services';
import { TEST_DATABASE_URL } from './global-setup.js';

export function testEnv(): void {
  process.env.APP_ENV = 'test';
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.APP_BASE_URL = 'http://localhost:3000';
  process.env.KEY_ENCRYPTION_KEYS = process.env.TEST_KEK ?? 'test-1:' + Buffer.alloc(32, 7).toString('base64');
  process.env.ENABLE_MOCK_PROVIDERS = 'true';
  process.env.S3_ENDPOINT ??= 'http://localhost:8333';
  process.env.S3_ACCESS_KEY_ID ??= 'socialite-local-access';
  process.env.S3_SECRET_ACCESS_KEY ??= 'socialite-local-secret-not-for-production';
  process.env.S3_BUCKET = 'social-lite-test';
  process.env.SMTP_URL ??= 'smtp://localhost:1025';
  process.env.LOG_LEVEL ??= 'warn';
  // AI model settings come only from the tests that need them (useTestModel), never from a developer's .env.
  for (const k of ['AI_MODEL', 'AI_FALLBACK_MODELS', 'AI_MODEL_PRICES']) delete process.env[k];
  resetConfigCache();
}

/** D32: AI needs a model setting. Tests that inject a fake client use a placeholder id (never a real model id). */
export const TEST_MODEL = 'test-model';
export function useTestModel(): void {
  process.env.AI_MODEL = TEST_MODEL;
  resetConfigCache();
}
/** Undo useTestModel (the integration project shares one process, so env must not leak into later files). */
export function clearTestModel(): void {
  delete process.env.AI_MODEL;
  resetConfigCache();
}

let pool: Pool | undefined;
export function testPool(): Pool {
  if (!pool) {
    testEnv();
    pool = createPool(TEST_DATABASE_URL, 10);
    setPool(pool);
  }
  return pool;
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    setPool(undefined);
    await p.end();
  }
}

export async function createUser(email = `u-${randomUUID().slice(0, 8)}@test.social-lite.test`, name = 'Test User'): Promise<{ id: string; email: string }> {
  const r = await testPool().query<{ id: string }>(
    `INSERT INTO users(oidc_issuer, oidc_subject, email, email_verified, name) VALUES ('test', $1, $2, true, $3) RETURNING id`,
    [randomUUID(), email, name]);
  return { id: r.rows[0]!.id, email };
}

export async function createWorkspace(name = 'Test Workspace', opts: { isDemo?: boolean } = {}): Promise<string> {
  const r = await testPool().query<{ id: string }>(`INSERT INTO workspaces(name, is_demo) VALUES ($1, $2) RETURNING id`, [name, opts.isDemo ?? true]);
  return r.rows[0]!.id;
}

export async function addMember(workspaceId: string, userId: string, role: Role, brandIds?: string[]): Promise<void> {
  await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role, brand_restricted) VALUES ($1,$2,$3,$4)`,
    [workspaceId, userId, role, !!brandIds]);
  for (const b of brandIds ?? []) {
    await testPool().query(`INSERT INTO membership_brand_grants(workspace_id, user_id, brand_id) VALUES ($1,$2,$3)`, [workspaceId, userId, b]);
  }
  // V2: authority comes from scoped grants (same mapping as the V1 backfill in migration 009).
  if (!brandIds || role === 'owner' || role === 'admin') {
    await testPool().query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, source) VALUES ($1,'user',$2,$3,'workspace','test')`, [workspaceId, userId, role]);
  } else {
    for (const b of brandIds) {
      await testPool().query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, brand_id, source) VALUES ($1,'user',$2,$3,'brand',$4,'test')`, [workspaceId, userId, role, b]);
    }
  }
}

/** V2 grant helper. */
export async function grant(workspaceId: string, userId: string, role: string, brandId?: string, expiresAt?: Date): Promise<string> {
  const r = await testPool().query<{ id: string }>(
    `INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, brand_id, expires_at, source)
     VALUES ($1,'user',$2,$3,$4,$5,$6,'test') RETURNING id`, [workspaceId, userId, role, brandId ? 'brand' : 'workspace', brandId ?? null, expiresAt ?? null]);
  return r.rows[0]!.id;
}

export async function createBrand(workspaceId: string, name = 'Test Brand', opts: { approvalRequired?: boolean; editorsCanPublish?: boolean } = {}): Promise<string> {
  const r = await testPool().query<{ id: string }>(
    `INSERT INTO brands(workspace_id, name, approval_required, editors_can_publish, is_demo) VALUES ($1,$2,$3,$4,true) RETURNING id`,
    [workspaceId, name, opts.approvalRequired ?? false, opts.editorsCanPublish ?? false]);
  return r.rows[0]!.id;
}

export function ctxFor(userId: string, workspaceId: string, role: Role, brandIds: string[] | null = null, email = 'test@test'): Ctx {
  return {
    actor: { userId, email, name: 'Test', sessionId: randomUUID() },
    access: { workspaceId, role, brandIds, isDemo: true },
    correlationId: randomUUID(),
  };
}

/** A complete tenant: workspace, brand, owner. */
export async function tenant(opts: { approvalRequired?: boolean; editorsCanPublish?: boolean } = {}) {
  const owner = await createUser();
  const workspaceId = await createWorkspace();
  const brandId = await createBrand(workspaceId, 'Brand', opts);
  await addMember(workspaceId, owner.id, 'owner');
  return { workspaceId, brandId, owner, ownerCtx: ctxFor(owner.id, workspaceId, 'owner') };
}

/**
 * V2 context built through the REAL policy path (loadAccess → authz). Use this in V2 tests.
 * Defaults to a session with verified MFA authenticated just now; override to test assurance gates.
 */
export async function v2Ctx(userId: string, workspaceId: string, assurance: { mfaVerified?: boolean; authTime?: string | null } = {}): Promise<Ctx> {
  const { loadAccess } = await import('@social-lite/services');
  const access = await loadAccess(userId, workspaceId, testPool(), { mfaVerified: assurance.mfaVerified ?? true, authTime: assurance.authTime === undefined ? new Date().toISOString() : assurance.authTime });
  if (!access) throw Object.assign(new Error('no access'), { code: 'forbidden' });
  const u = await testPool().query<{ email: string }>(`SELECT email FROM users WHERE id=$1`, [userId]);
  return { actor: { userId, email: u.rows[0]?.email ?? 'x', name: 'Test', sessionId: randomUUID() }, access, correlationId: randomUUID() };
}
