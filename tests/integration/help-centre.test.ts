// HC — Help Centre audience filtering against a real Postgres: the reader's audiences come from the session's membership
// grants and the platform operator row (never the browser), and decide which articles, search hits, related links and
// bundle files they get. A member never gets admin articles; signed-out readers only get public ones.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSession } from '@social-lite/services/auth/session';
import { helpViewerFor, SIGNED_OUT_VIEWER } from '@social-lite/services/help/access';
import { articleFor, readHelpLibrary, readableArticles, searchHelp, type HelpLibrary } from '@social-lite/services/help/library';
import { buildHelpBundle } from '@social-lite/services/help/bundle';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, grant, testPool } from './helpers.js';

let dir: string;
let lib: HelpLibrary;
const head = (title: string, section: string, audience: string) =>
  `---\ntitle: ${title}\nsummary: About ${title.toLowerCase()}.\nsection: ${section}\naudience: ${audience}\nstatus: available\nproduct_version: "2026-11"\nreviewed: 2026-11-09\n---\n\n## Overview\n\n`;

beforeAll(() => {
  testPool();
  dir = mkdtempSync(join(tmpdir(), 'help-int-'));
  const put = (section: string, slug: string, audience: string, text: string) => {
    mkdirSync(join(dir, section), { recursive: true });
    writeFileSync(join(dir, section, `${slug}.md`), head(slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), section, audience) + text);
  };
  put('getting-started', 'what-is-relay', 'public', 'Relay plans and publishes posts for teams. Workspace basics live here.');
  put('publishing', 'create-a-post', 'user', 'Write a post for each channel in the workspace and save a draft.');
  put('administration', 'workspace-security-policy', 'admin', 'Require two-step verification for every workspace role.');
  put('developers', 'api-keys', 'developer', 'Create a workspace API key for the REST API.');
  lib = readHelpLibrary(dir);
});
afterAll(async () => { rmSync(dir, { recursive: true, force: true }); await closeTestPool(); });

async function sessionFor(userId: string, workspaceId: string | null) {
  const { session } = await createSession(testPool(), userId, workspaceId ? { workspaceId } : {});
  return { session: { ...session, activeWorkspaceId: workspaceId }, actor: { userId, email: 'x@test.social-lite.test', name: 'X', sessionId: session.id } };
}

describe('help audiences from the database', () => {
  it('owner/admin → admin articles; editor/viewer → members only; guest-only → public; staff → all; signed out → public', async () => {
    const ws = await createWorkspace('Help');
    const brand = await createBrand(ws, 'Brand');
    const owner = await createUser(); await addMember(ws, owner.id, 'owner');
    const admin = await createUser(); await addMember(ws, admin.id, 'admin');
    const editor = await createUser(); await addMember(ws, editor.id, 'editor', [brand]);
    const viewer = await createUser(); await addMember(ws, viewer.id, 'viewer');
    const guest = await createUser();
    await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [ws, guest.id]);
    await grant(ws, guest.id, 'guest', brand, new Date(Date.now() + 86_400_000));
    const staff = await createUser();
    await testPool().query(`INSERT INTO platform_operators(user_id, role, granted_via) VALUES ($1,'support','seed')`, [staff.id]);
    const lonely = await createUser(); // signed in, no workspace yet (onboarding)

    const v = async (id: string, w: string | null) => helpViewerFor(await sessionFor(id, w), testPool());
    expect((await v(owner.id, ws)).audiences).toEqual(['public', 'user', 'developer', 'admin']);
    expect((await v(admin.id, ws)).admin).toBe(true);
    for (const id of [editor.id, viewer.id]) expect((await v(id, ws)).audiences).toEqual(['public', 'user', 'developer']);
    expect((await v(guest.id, ws)).audiences).toEqual(['public']);
    expect(await v(staff.id, null)).toMatchObject({ platformStaff: true, audiences: ['public', 'user', 'developer', 'admin'] });
    expect((await v(lonely.id, null)).audiences).toEqual(['public', 'user', 'developer']);
    expect(await helpViewerFor(null, testPool())).toEqual(SIGNED_OUT_VIEWER);

    // Removing the admin's membership takes the admin audience away on the next request.
    await testPool().query(`UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND user_id=$2`, [ws, admin.id]);
    expect((await v(admin.id, ws)).audiences).toEqual(['public', 'user', 'developer']);
  });

  it('a member never gets admin articles — page, search or bundle; signed-out readers only public', async () => {
    const ws = await createWorkspace('Help 2');
    const editor = await createUser(); await addMember(ws, editor.id, 'editor');
    const owner = await createUser(); await addMember(ws, owner.id, 'owner');
    const member = (await helpViewerFor(await sessionFor(editor.id, ws), testPool())).audiences;
    const adminA = (await helpViewerFor(await sessionFor(owner.id, ws), testPool())).audiences;
    const out = SIGNED_OUT_VIEWER.audiences;

    expect(readableArticles(lib, out).map((a) => a.slug)).toEqual(['what-is-relay']);
    expect(readableArticles(lib, member).map((a) => a.slug).sort()).toEqual(['api-keys', 'create-a-post', 'what-is-relay']);
    expect(readableArticles(lib, adminA)).toHaveLength(4);

    expect(articleFor(lib, 'workspace-security-policy', member)).toEqual({ article: null, hidden: true });
    expect(articleFor(lib, 'create-a-post', out)).toEqual({ article: null, hidden: true });
    expect(searchHelp(lib, member, 'two-step verification')).toEqual([]);
    expect(searchHelp(lib, adminA, 'two-step verification').map((r) => r.slug)).toEqual(['workspace-security-policy']);
    expect(searchHelp(lib, out, 'workspace').map((r) => r.slug)).toEqual(['what-is-relay']);

    const files = (aud: typeof member) => buildHelpBundle(lib, { audiences: aud, publicDir: dir }).map((f) => f.path);
    expect(files(member).some((p) => p.includes('workspace-security-policy'))).toBe(false);
    expect(files(adminA).some((p) => p.includes('workspace-security-policy'))).toBe(true);
  });
});
