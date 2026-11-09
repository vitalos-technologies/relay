// Setup page model, readiness and diagnostics against real PostgreSQL, SeaweedFS, Keycloak and Mailpit.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@social-lite/services';
import { diagnostics, readiness } from '../../packages/services/src/diagnostics.js';
import { getSetup, putSetup } from '../../packages/services/src/setup.js';
import { platformIntegrations, type PlatformCtx } from '../../packages/services/src/admin/platform.js';
import { getSetting } from '../../packages/services/src/settings.js';
import { ensureBucket } from '../../packages/services/src/storage.js';
import { addMember, closeTestPool, createUser, ctxFor, tenant, testPool } from './helpers.js';

const KEYS = ['META_APP_ID', 'META_APP_SECRET', 'ANTHROPIC_API_KEY', 'AI_MODEL', 'AI_MODEL_PRICES', 'AI_FALLBACK_MODELS', 'OIDC_ISSUER', 'TELEGRAM_WEBHOOK_SECRET', 'GOOGLE_CONTENT_CLIENT_SECRET', 'NOTION_CLIENT_SECRET', 'NOTION_INTERNAL_TOKEN'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let t: Awaited<ReturnType<typeof tenant>>;

beforeAll(async () => {
  testPool();
  t = await tenant();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  resetConfigCache();
});
afterAll(async () => {
  await testPool().query(`DELETE FROM app_settings`);
  await closeTestPool();
});

describe('setup', () => {
  it('reports grouped readiness and never returns secret values', async () => {
    delete process.env.META_APP_ID; delete process.env.META_APP_SECRET; delete process.env.ANTHROPIC_API_KEY;
    process.env.TELEGRAM_WEBHOOK_SECRET = 'env-telegram-secret-value-123';
    // V3 Content Hub secrets (Google Drive & Docs, Notion) are write-only too.
    process.env.GOOGLE_CONTENT_CLIENT_SECRET = 'env-google-content-secret-456';
    process.env.NOTION_CLIENT_SECRET = 'env-notion-client-secret-789';
    process.env.NOTION_INTERNAL_TOKEN = 'ntn_envinternaltokenvalue0123456789';
    resetConfigCache();
    const { groups } = await getSetup(t.ownerCtx);
    expect(groups.map((g) => g.id)).toEqual(['core', 'identity', 'storage', 'email', 'meta', 'telegram', 'x', 'tiktok', 'youtube', 'linkedin', 'threads', 'pinterest', 'google_content', 'notion', 'ai', 'tipsignal',
      // V3.5 business integrations (stream C)
      'asana', 'monday', 'hubspot', 'gbp', 'translate', 'slack', 'mailchimp']);
    const all = groups.flatMap((g) => g.items);
    const item = (k: string) => all.find((i) => i.key === k)!;
    expect(item('APP_BASE_URL')).toMatchObject({ source: 'env', is_set: true, value: 'http://localhost:3000', editable: false });
    expect(item('KEY_ENCRYPTION_KEYS')).toMatchObject({ secret: true, is_set: true, editable: false });
    expect(item('KEY_ENCRYPTION_KEYS').value).toBeUndefined();
    expect(item('TELEGRAM_WEBHOOK_SECRET')).toMatchObject({ source: 'env', is_set: true, editable: false });
    expect(item('META_APP_SECRET')).toMatchObject({ source: null, is_set: false, editable: true, secret: true });
    expect(JSON.stringify(groups)).not.toContain('env-telegram-secret-value-123');
    for (const v of ['env-google-content-secret-456', 'env-notion-client-secret-789', 'ntn_envinternaltokenvalue0123456789']) expect(JSON.stringify(groups)).not.toContain(v);
    expect(item('NOTION_CLIENT_SECRET')).toMatchObject({ source: 'env', is_set: true, secret: true, editable: false });
    expect(item('NOTION_CLIENT_SECRET').value).toBeUndefined();
    expect(item('GOOGLE_CONTENT_CLIENT_SECRET').value).toBeUndefined();
    expect(JSON.stringify(groups)).not.toContain(process.env.KEY_ENCRYPTION_KEYS!.split(':')[1]);
    expect(groups.find((g) => g.id === 'meta')!.ready).toBe(false);

    const secret = 'abcdef0123456789abcdef0123456789';
    const put = await putSetup(t.ownerCtx, 'META_APP_SECRET', secret);
    expect(put).toMatchObject({ key: 'META_APP_SECRET', is_set: true, source: 'setup', secret: true });
    expect(put.value).toBeUndefined();
    expect(await putSetup(t.ownerCtx, 'META_APP_ID', '1234567890')).toMatchObject({ value: '1234567890', source: 'setup' });
    expect(await getSetting('META_APP_SECRET')).toBe(secret);
    const webhookSecret = 'notion-webhook-verification-secret-xyz';
    expect((await putSetup(t.ownerCtx, 'NOTION_WEBHOOK_VERIFICATION_TOKEN', webhookSecret)).value).toBeUndefined();
    const after = await getSetup(t.ownerCtx);
    expect(JSON.stringify(after)).not.toContain(secret);
    expect(JSON.stringify(after)).not.toContain(webhookSecret);
    expect(after.groups.find((g) => g.id === 'meta')!.ready).toBe(true);
    const audit = await testPool().query<{ diff: unknown }>(`SELECT diff FROM audit_events WHERE workspace_id=$1 AND action='setup.updated'`, [t.workspaceId]);
    expect(audit.rowCount).toBe(3);
    expect(JSON.stringify(audit.rows)).not.toContain(webhookSecret);
    expect(JSON.stringify(audit.rows)).not.toContain(secret);

    // Clearing works; invalid values and env-provided/env-only keys are refused.
    expect(await putSetup(t.ownerCtx, 'META_APP_SECRET', '')).toMatchObject({ is_set: false, source: null });
    await expect(putSetup(t.ownerCtx, 'ANTHROPIC_API_KEY', 'not-a-key')).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(putSetup(t.ownerCtx, 'TELEGRAM_WEBHOOK_SECRET', 'another-secret-value-xyz')).rejects.toMatchObject({ code: 'conflict' });
    await expect(putSetup(t.ownerCtx, 'SESSION_SECRET', 'x')).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(putSetup(t.ownerCtx, 'NOPE', 'x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('AI setup (D32): key, model and prices show as set / not set, never their values; model settings are environment-only', async () => {
    const aiGroup = async () => (await getSetup(t.ownerCtx)).groups.find((g) => g.id === 'ai')!;
    const op: PlatformCtx = { actor: { userId: t.owner.id, email: 'op@relay.test', name: 'Op', sessionId: 'sess' }, role: 'operator', assurance: { mfaVerified: true, authTime: new Date() }, correlationId: 'c' } as PlatformCtx;
    const diag = async () => (await platformIntegrations(op)).items.find((i) => i.key === 'ai')!;
    delete process.env.ANTHROPIC_API_KEY; delete process.env.AI_MODEL; delete process.env.AI_MODEL_PRICES; delete process.env.AI_FALLBACK_MODELS;
    resetConfigCache();
    let g = await aiGroup();
    expect(g.items.map((i) => i.key)).toEqual(['ANTHROPIC_API_KEY', 'AI_MODEL', 'AI_MODEL_PRICES', 'AI_FALLBACK_MODELS']);
    expect(g.items.map((i) => i.is_set)).toEqual([false, false, false, false]);
    expect(g.ready).toBe(false);
    expect(await diag()).toMatchObject({ status: 'not_configured', missing: ['ANTHROPIC_API_KEY', 'AI_MODEL'] });

    // Key only ⇒ still not set up (no default model).
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-000000';
    resetConfigCache();
    expect((await aiGroup()).ready).toBe(false);
    expect(await diag()).toMatchObject({ status: 'not_configured', missing: ['AI_MODEL'] });

    // Key + model (placeholder id) ⇒ ready; prices optional, flagged when missing for the model.
    process.env.AI_MODEL = 'test-model';
    process.env.AI_FALLBACK_MODELS = 'test-model';
    resetConfigCache();
    g = await aiGroup();
    expect(g.ready).toBe(true);
    const item = (k: string) => g.items.find((i) => i.key === k)!;
    expect(item('AI_MODEL')).toMatchObject({ is_set: true, source: 'env', editable: false });
    expect(item('AI_MODEL_PRICES')).toMatchObject({ is_set: false, warning: expect.stringMatching(/unknown/) });
    expect(item('AI_FALLBACK_MODELS')).toMatchObject({ is_set: true });
    expect(await diag()).toMatchObject({ status: 'configured', missing: [], note: expect.stringMatching(/cost estimates unknown/) });
    process.env.AI_MODEL_PRICES = JSON.stringify({ 'test-model': [1.25, 5] });
    resetConfigCache();
    g = await aiGroup();
    expect(g.items.find((i) => i.key === 'AI_MODEL_PRICES')).toMatchObject({ is_set: true, source: 'env' });
    expect(g.items.find((i) => i.key === 'AI_MODEL_PRICES')!.warning).toBeUndefined();
    // Values never leave the server.
    const json = JSON.stringify([g, await diag()]);
    for (const v of ['test-model', '1.25', 'sk-ant-test-key-000000']) expect(json).not.toContain(v);
    for (const k of ['AI_MODEL', 'AI_MODEL_PRICES', 'AI_FALLBACK_MODELS']) await expect(putSetup(t.ownerCtx, k, 'x')).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('is owner-only', async () => {
    const admin = await createUser();
    await addMember(t.workspaceId, admin.id, 'admin');
    const ctx = ctxFor(admin.id, t.workspaceId, 'admin');
    await expect(getSetup(ctx)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(putSetup(ctx, 'META_APP_ID', '123456')).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('readiness and diagnostics', () => {
  it('is ready when the database is reachable and all migrations are applied', async () => {
    const r = await readiness(testPool());
    expect(r).toMatchObject({ status: 'ready', checks: { database: { ok: true }, migrations: { ok: true } } });
  });

  it('reports not ready when a migration file has not been applied', async () => {
    const db = testPool();
    const row = (await db.query<{ name: string; checksum: string }>(`SELECT name, checksum FROM schema_migrations ORDER BY name DESC LIMIT 1`)).rows[0]!;
    await db.query(`DELETE FROM schema_migrations WHERE name=$1`, [row.name]);
    try {
      const r = await readiness(db);
      expect(r.status).toBe('not_ready');
      expect(r.checks.migrations).toMatchObject({ ok: false, detail: '1 migration(s) not applied' });
    } finally {
      await db.query(`INSERT INTO schema_migrations(name, checksum) VALUES ($1,$2)`, [row.name, row.checksum]);
    }
  });

  it('checks database, storage, OIDC, SMTP, worker heartbeat and dispatch flag (owner/admin only)', async () => {
    process.env.OIDC_ISSUER = 'http://localhost:5556/realms/social-lite'; // local Keycloak realm
    resetConfigCache();
    await ensureBucket();
    const db = testPool();
    await db.query(`DELETE FROM worker_heartbeats`);
    let r = await diagnostics(t.ownerCtx, db);
    const by = (name: string) => r.checks.find((c) => c.name === name)!;
    expect(r.checks.map((c) => c.name)).toEqual(['database', 'storage', 'oidc', 'smtp', 'worker_heartbeat', 'dispatch_enabled']);
    expect(by('database').ok).toBe(true);
    expect(by('storage')).toMatchObject({ ok: true, detail: 'bucket social-lite-test reachable' });
    expect(by('oidc').ok).toBe(true);
    expect(by('smtp').ok).toBe(true);
    expect(by('worker_heartbeat')).toMatchObject({ ok: false, detail: 'no worker has reported a heartbeat' });
    expect(by('dispatch_enabled').ok).toBe(true);

    await db.query(`INSERT INTO worker_heartbeats(worker_id, last_seen_at) VALUES ('w-test', now())`);
    await db.query(`UPDATE system_flags SET value='false'::jsonb WHERE key='dispatch_enabled'`);
    try {
      r = await diagnostics(t.ownerCtx, db);
      expect(by('worker_heartbeat').ok).toBe(true);
      expect(by('dispatch_enabled').ok).toBe(false);
    } finally {
      await db.query(`UPDATE system_flags SET value='true'::jsonb WHERE key='dispatch_enabled'`);
      await db.query(`DELETE FROM worker_heartbeats WHERE worker_id='w-test'`);
    }

    const editor = await createUser();
    await addMember(t.workspaceId, editor.id, 'editor');
    await expect(diagnostics(ctxFor(editor.id, t.workspaceId, 'editor'), db)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
