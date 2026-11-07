// Invitations (expiry, email binding, revoke, single use) and member management on the V2 model
// (scoped grants; memberships.role is a legacy summary). Real PostgreSQL + real SMTP capture via Mailpit.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '@social-lite/db';
import { loadAccess } from '@social-lite/services';
import {
  acceptInvitation, createInvitation, listInvitations, maskEmail, previewInvitation, revokeInvitation,
} from '../../packages/services/src/auth/invitations.js';
import { sha256 } from '../../packages/services/src/auth/session.js';
import { LoginError } from '../../packages/services/src/auth/users.js';
import { listMembers, updateMember } from '../../packages/services/src/members.js';
import { removalImpact, removeMember } from '../../packages/services/src/lifecycle.js';
import { addMember, closeTestPool, createBrand, createUser, tenant, testPool, v2Ctx } from './helpers.js';

let t: Awaited<ReturnType<typeof tenant>>;
/** Owner context through the real V2 policy path (fresh per call). */
const own = (w: { owner: { id: string }; workspaceId: string } = t) => v2Ctx(w.owner.id, w.workspaceId);
const key = () => `idem-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const tokenOf = (acceptUrl: string) => decodeURIComponent(acceptUrl.split('/invite/')[1]!);

beforeAll(async () => {
  testPool();
  t = await tenant();
});
afterAll(closeTestPool);

async function accept(token: string, user: { id: string; email: string }) {
  return withTx((tx) => acceptInvitation(tx, sha256(token), user), testPool());
}

async function expectLoginError(p: Promise<unknown>, code: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(LoginError);
  expect((err as LoginError).code).toBe(code);
}

describe('invitations', () => {
  it('stores only the token hash, returns accept_url once, emails the invitee, and is idempotent', async () => {
    const email = `new-${Date.now()}@example.test`;
    const k = key();
    const r = await createInvitation(await own(), { email, role: 'editor' }, k);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ email, role: 'editor', status: 'pending', brand_ids: [] });
    expect(r.body.accept_url).toMatch(/^http:\/\/localhost:3000\/invite\/[A-Za-z0-9_-]{40,}$/);
    const token = tokenOf(r.body.accept_url!);
    const row = (await testPool().query<{ token_hash: Buffer; expires_at: Date }>(`SELECT token_hash, expires_at FROM invitations WHERE id=$1`, [r.body.id])).rows[0]!;
    expect(row.token_hash.equals(sha256(token))).toBe(true);
    const dbDump = JSON.stringify((await testPool().query(`SELECT * FROM invitations WHERE id=$1`, [r.body.id])).rows);
    expect(dbDump).not.toContain(token);
    // V2 default: 72 h (workspaces.security_policy.invite_ttl_hours).
    expect(row.expires_at.getTime() - Date.now()).toBeGreaterThan(71.9 * 3600_000);
    expect(row.expires_at.getTime() - Date.now()).toBeLessThanOrEqual(72 * 3600_000 + 5000);

    // Replay with the same key: same invitation, no token re-disclosure, no duplicate.
    const replay = await createInvitation(await own(), { email, role: 'editor' }, k);
    expect(replay.body.id).toBe(r.body.id);
    expect(replay.body.accept_url).toBeUndefined();
    const idemDump = JSON.stringify((await testPool().query(`SELECT response_body FROM idempotency_keys WHERE key=$1`, [k])).rows);
    expect(idemDump).not.toContain(token);
    await expect(createInvitation(await own(), { email, role: 'viewer' }, k)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    // A second open invitation for the same email is refused.
    await expect(createInvitation(await own(), { email, role: 'viewer' }, key())).rejects.toMatchObject({ code: 'conflict' });
    await expect(createInvitation(await own(), { email, role: 'viewer' }, null)).rejects.toMatchObject({ code: 'validation_failed' });

    // Email delivered synchronously after commit via SMTP (Mailpit locally) and contains the accept link.
    expect(r.body.email_sent).toBe(true);
    const res = await fetch(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const found = (await res.json()) as { messages: Array<{ ID: string }> };
    expect(found.messages.length).toBe(1);
    const msg = (await (await fetch(`http://localhost:8025/api/v1/message/${found.messages[0]!.ID}`)).json()) as { Text: string };
    expect(msg.Text).toContain(r.body.accept_url);

    const preview = await previewInvitation(token);
    expect(preview).toMatchObject({ role: 'editor', status: 'pending', email_hint: maskEmail(email) });
    expect(preview.email_hint).not.toBe(email);
    await expect(previewInvitation('nope')).rejects.toMatchObject({ code: 'not_found' });
    expect((await listInvitations(await own())).map((i) => i.id)).toContain(r.body.id);
  });

  it('binds acceptance to the invited email (case-insensitive) and is single use', async () => {
    const email = `Bound-${Date.now()}@Example.test`;
    const brand2 = await createBrand(t.workspaceId, 'Restricted brand');
    const r = await createInvitation(await own(), { email, role: 'approver', brand_ids: [brand2] }, key());
    const token = tokenOf(r.body.accept_url!);
    const wrong = await createUser(`someone-else-${Date.now()}@example.test`);
    await expectLoginError(accept(token, wrong), 'email_mismatch');
    expect(await loadAccess(wrong.id, t.workspaceId, testPool())).toBeNull();

    const right = await createUser(email.toLowerCase());
    const res = await accept(token, right);
    expect(res).toEqual({ workspaceId: t.workspaceId, alreadyMember: false });
    expect(await loadAccess(right.id, t.workspaceId, testPool())).toMatchObject({ role: 'approver', brandIds: [brand2] });
    expect((await previewInvitation(token)).status).toBe('accepted');

    // Single use: a second acceptance (even by the same person) fails.
    await expectLoginError(accept(token, right), 'invitation_used');
    expect((await listInvitations(await own())).map((i) => i.id)).not.toContain(r.body.id);
  });

  it('refuses expired and revoked invitations', async () => {
    const e1 = `exp-${Date.now()}@example.test`;
    const r1 = await createInvitation(await own(), { email: e1, role: 'viewer' }, key());
    await testPool().query(`UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id=$1`, [r1.body.id]);
    const u1 = await createUser(e1);
    await expectLoginError(accept(tokenOf(r1.body.accept_url!), u1), 'invitation_expired');
    expect((await previewInvitation(tokenOf(r1.body.accept_url!))).status).toBe('expired');
    expect((await listInvitations(await own())).find((i) => i.id === r1.body.id)?.status).toBe('expired');
    // An expired invitation is replaced when re-inviting.
    const again = await createInvitation(await own(), { email: e1, role: 'viewer' }, key());
    expect(again.body.id).not.toBe(r1.body.id);

    const e2 = `rev-${Date.now()}@example.test`;
    const r2 = await createInvitation(await own(), { email: e2, role: 'viewer' }, key());
    await revokeInvitation(await own(), r2.body.id);
    const u2 = await createUser(e2);
    await expectLoginError(accept(tokenOf(r2.body.accept_url!), u2), 'invitation_revoked');
    expect((await previewInvitation(tokenOf(r2.body.accept_url!))).status).toBe('revoked');
    await expectLoginError(accept('totally-unknown-token', u2), 'invitation_invalid');
  });

  it('only owners/admins invite; owners cannot be invited; cross-tenant revoke is not_found', async () => {
    const editor = await createUser();
    await addMember(t.workspaceId, editor.id, 'editor');
    await expect(createInvitation(await v2Ctx(editor.id, t.workspaceId), { email: 'x@example.test', role: 'viewer' }, key()))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(createInvitation(await own(), { email: 'x@example.test', role: 'owner' }, key())).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(createInvitation(await own(), { email: 'not-an-email', role: 'viewer' }, key())).rejects.toMatchObject({ code: 'validation_failed' });
    const r = await createInvitation(await own(), { email: `xt-${Date.now()}@example.test`, role: 'viewer' }, key());
    const other = await tenant();
    await expect(revokeInvitation(await own(other), r.body.id)).rejects.toMatchObject({ code: 'not_found' });
    // Inviting an existing member is refused.
    await expect(createInvitation(await own(), { email: t.owner.email, role: 'viewer' }, key())).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('members', () => {
  it('lists members with brand grants; updates grants; removal blocks access and reports impact', async () => {
    const w = await tenant();
    const b2 = await createBrand(w.workspaceId, 'Other');
    const editor = await createUser();
    await addMember(w.workspaceId, editor.id, 'editor', [w.brandId]);
    const { members } = await listMembers(await own(w));
    expect(members.find((m) => m.user_id === editor.id)).toMatchObject({ role: 'editor', brand_ids: [w.brandId], status: 'active' });
    expect(members.find((m) => m.user_id === editor.id)!.grants).toEqual([expect.objectContaining({ role: 'editor', scope_type: 'brand', brand_id: w.brandId, via: 'direct' })]);
    expect(members.find((m) => m.user_id === w.owner.id)).toMatchObject({ role: 'owner', brand_ids: null, is_owner: true });

    // Legacy PATCH {brand_ids} is translated into scoped grants (and bumps the policy version).
    const pv = (await own(w)).access.authz!.policyVersion;
    expect((await updateMember(await own(w), editor.id, { brand_ids: [w.brandId, b2] })).brand_ids?.sort()).toEqual([w.brandId, b2].sort());
    expect((await own(w)).access.authz!.policyVersion).toBeGreaterThan(pv);
    expect((await updateMember(await own(w), editor.id, { brand_ids: null })).brand_ids).toBeNull();
    // Another workspace's brand id is rejected (no existence leak).
    await expect(updateMember(await own(w), editor.id, { brand_ids: [t.brandId] })).rejects.toMatchObject({ code: 'validation_failed' });

    // Drafts created by the member are reported in the handover preview.
    await testPool().query(`INSERT INTO posts(workspace_id, brand_id, created_by) VALUES ($1,$2,$3)`, [w.workspaceId, w.brandId, editor.id]);
    expect(await removalImpact(await own(w), editor.id)).toMatchObject({ approved_schedules_remaining: 0, drafts_losing_access: 1, pending_approvals: { requested: 0 } });
    const removed = await removeMember(await own(w), editor.id);
    expect(removed.impact.drafts.count).toBe(1);
    expect(await loadAccess(editor.id, w.workspaceId, testPool())).toBeNull();
    expect((await listMembers(await own(w))).members.map((m) => m.user_id)).not.toContain(editor.id);
    await expect(removeMember(await own(w), editor.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(removeMember(await own(w), w.owner.id)).rejects.toMatchObject({ code: 'invalid_state' });
    // History is kept: the post still exists, attributed to its author.
    expect((await testPool().query(`SELECT count(*)::int n FROM posts WHERE workspace_id=$1 AND created_by=$2`, [w.workspaceId, editor.id])).rows[0].n).toBe(1);
    const audit = await testPool().query(`SELECT action FROM audit_events WHERE workspace_id=$1 AND action='member.removed'`, [w.workspaceId]);
    expect(audit.rowCount).toBe(1);

    // A removed member can be re-invited and re-joins with the new role.
    const r = await createInvitation(await own(w), { email: editor.email, role: 'viewer' }, key());
    await accept(tokenOf(r.body.accept_url!), editor);
    expect(await loadAccess(editor.id, w.workspaceId, testPool())).toMatchObject({ role: 'viewer', brandIds: null });
  });
});
