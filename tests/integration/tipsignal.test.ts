import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { draftText, receiveTipsignal, signTipsignal } from '@social-lite/services/tipsignal';
import { resetConfigCache } from '@social-lite/services';
import { closeTestPool, tenant, testPool } from './helpers.js';
import { seedConnections } from './engine-helpers.js';
import { ensureBucket } from '@social-lite/services/storage';

const SECRET = 'test-tipsignal-secret-0123456789abcdef';
let brandId = '';
let workspaceId = '';
let saId = '';
afterAll(closeTestPool);
beforeAll(async () => {
  testPool();
  process.env.TIPSIGNAL_SIGNING_SECRET = SECRET;
  resetConfigCache();
  await ensureBucket();
  const t = await tenant();
  brandId = t.brandId;
  workspaceId = t.workspaceId;
  await seedConnections(t.workspaceId, t.brandId);
  await testPool().query(`DELETE FROM integration_bindings WHERE kind='tipsignal'`);
  // V2: the binding names a service account holding ONLY an integration grant (content.create_draft) on the brand.
  saId = (await testPool().query<{ id: string }>(`INSERT INTO service_accounts(workspace_id, name, owner_user_id, purpose) VALUES ($1,'TipSignal',$2,'tipsignal') RETURNING id`, [t.workspaceId, t.owner.id])).rows[0]!.id;
  await testPool().query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, service_account_id, role, scope_type, brand_id, source) VALUES ($1,'service_account',$2,'integration','brand',$3,'test')`, [t.workspaceId, saId, t.brandId]);
  await testPool().query(`INSERT INTO integration_bindings(kind, workspace_id, brand_id, service_account_id) VALUES ('tipsignal',$1,$2,$3)`, [t.workspaceId, t.brandId, saId]);
});

const kickoff = new Date(Date.now() + 86_400_000).toISOString();
const pick = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  schema_version: 1, event_id: id, type: 'picks.ready', occurred_at: new Date().toISOString(),
  data: { record_id: 'rec-1', source_url: 'https://tipsignal.example/r/1', fixture: { home: 'Northfield', away: 'Southport', competition: 'League One', kickoff_at: kickoff },
    market: 'Match result', selection: 'Northfield', probability: 0.6234, ...extra },
});

describe('TipSignal events', () => {
  it('creates exactly one draft with exact facts and a validated graphic; retries are deduplicated', async () => {
    const raw = pick(`evt-${Date.now()}`);
    const r = await receiveTipsignal(raw, signTipsignal(SECRET, raw));
    expect(r.status).toBe(201);
    const again = await receiveTipsignal(raw, signTipsignal(SECRET, raw));
    expect(again.body).toMatchObject({ duplicate: true, status: 'draft_created' });
    const post = await testPool().query(`SELECT draft, source FROM posts WHERE id=$1`, [(r.body as { post_id: string }).post_id]);
    expect(post.rows[0].draft.baseText).toContain('Model probability: 62.3%. Probabilities are estimates, not promises.');
    expect(post.rows[0].source.record_id).toBe('rec-1');
    const asset = await testPool().query(`SELECT status FROM assets WHERE id=$1`, [post.rows[0].draft.baseAssetIds[0]]);
    expect(asset.rows[0].status).toBe('ready');
    const sched = await testPool().query(`SELECT count(*)::int n FROM schedules WHERE post_id=$1`, [(r.body as { post_id: string }).post_id]);
    expect(sched.rows[0].n).toBe(0); // draft only, never auto-published
    // Attributed to the service account (no human author), in the bound workspace/brand.
    const row = await testPool().query(`SELECT created_by, workspace_id, brand_id, source FROM posts WHERE id=$1`, [(r.body as { post_id: string }).post_id]);
    expect(row.rows[0]).toMatchObject({ created_by: null, workspace_id: workspaceId, brand_id: brandId });
    expect(row.rows[0].source.service_account_id).toBe(saId);
    const audit = await testPool().query(`SELECT actor_user_id, actor_service FROM audit_events WHERE resource_id=$1 AND action='post.created'`, [(r.body as { post_id: string }).post_id]);
    expect(audit.rows).toEqual([{ actor_user_id: null, actor_service: `service_account:${saId}` }]);
  });

  it('the service account is the principal: revoked grant or disabled account ⇒ rejected; it can never publish', async () => {
    const { serviceAccountCtx } = await import('@social-lite/services/service-accounts');
    const { authorizeCtx } = await import('@social-lite/services');
    const ctx = await serviceAccountCtx({ serviceAccountId: saId, workspaceId });
    for (const p of ['content.publish', 'content.schedule', 'content.edit', 'content.read', 'assets.upload', 'members.invite'] as const) {
      expect(authorizeCtx(ctx, p, { brandId }).allowed, p).toBe(false);
    }
    expect(authorizeCtx(ctx, 'content.create_draft', { brandId }).allowed).toBe(true);
    await testPool().query(`UPDATE scoped_role_grants SET revoked_at=now() WHERE service_account_id=$1`, [saId]);
    const raw = pick(`evt-revoked-${Date.now()}`);
    const r = await receiveTipsignal(raw, signTipsignal(SECRET, raw));
    expect(r).toMatchObject({ status: 422, body: { status: 'rejected' } });
    await testPool().query(`UPDATE scoped_role_grants SET revoked_at=NULL WHERE service_account_id=$1`, [saId]);
    await testPool().query(`UPDATE service_accounts SET disabled_at=now() WHERE id=$1`, [saId]);
    const raw2 = pick(`evt-disabled-${Date.now()}`);
    expect((await receiveTipsignal(raw2, signTipsignal(SECRET, raw2))).status).toBe(422);
    await testPool().query(`UPDATE service_accounts SET disabled_at=NULL WHERE id=$1`, [saId]);
    const raw3 = pick(`evt-ok-${Date.now()}`);
    expect((await receiveTipsignal(raw3, signTipsignal(SECRET, raw3))).status).toBe(201);
  });

  it('the tenant comes from the registered integration, never the payload', async () => {
    const raw = JSON.stringify({ ...JSON.parse(pick(`evt-tenant-${Date.now()}`)), workspace_id: '00000000-0000-0000-0000-000000000000' });
    await expect(receiveTipsignal(raw, signTipsignal(SECRET, raw))).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('rejects bad signatures, stale timestamps, destination overrides and expired picks', async () => {
    const raw = pick(`evt-sig-${Date.now()}`);
    await expect(receiveTipsignal(raw, signTipsignal('wrong', raw))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(receiveTipsignal(raw, signTipsignal(SECRET, raw, Math.floor(Date.now() / 1000) - 3600))).rejects.toMatchObject({ code: 'forbidden' });
    const override = pick(`evt-ovr-${Date.now()}`, { destination: 'some-other-channel' });
    await expect(receiveTipsignal(override, signTipsignal(SECRET, override))).rejects.toMatchObject({ code: 'validation_failed' });
    const late = JSON.stringify({ ...JSON.parse(pick(`evt-late-${Date.now()}`)), data: { ...JSON.parse(pick('x')).data, fixture: { ...JSON.parse(pick('x')).data.fixture, kickoff_at: new Date(Date.now() - 60_000).toISOString() } } });
    const r = await receiveTipsignal(late, signTipsignal(SECRET, late));
    expect(r.status).toBe(422);
  });

  it('result copy uses only validated facts', () => {
    const text = draftText({ schema_version: 1, event_id: 'e', type: 'results.settled', occurred_at: kickoff,
      data: { record_id: 'r', source_url: 'https://t.example/1', fixture: { home: 'A', away: 'B', competition: 'Cup', kickoff_at: kickoff }, market: 'BTTS', selection: 'Yes',
        settled: true, settled_at: kickoff, result: 'won', final_score: '2-1' } }, 'Europe/London');
    expect(text).toContain('A 2-1 B');
    expect(text).toContain('Pick: Yes (BTTS) — Won');
    expect(brandId).toBeTruthy();
  });
});
