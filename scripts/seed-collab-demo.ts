// SYNTHETIC collaboration demo data (local/dev only) for screenshots, manual QA and the collaboration perf run.
//   set -a; . ./.env; set +a; npx tsx scripts/seed-collab-demo.ts ["Demo Workspace"] [--volume N]
// Idempotent per workspace: a post titled "Spring menu launch (collaboration demo)" marks it as done.
// Creates through the real services (same authorization, audit, outbox, notifications): a post with internal and shared
// discussions (mentions, replies, an anchor, a resolved thread), tasks (due soon, overdue, unassigned) and a review request
// on the approval brand. --volume N adds N extra threads (+ replies) and N tasks to one post for performance checks.
import { randomUUID } from 'node:crypto';
import { closePool, getPool, maybeOne, many } from '@social-lite/db';
import {
  config, createPost, createTask, createThread, loadAccess, replyToThread, requestReviewers, setThreadResolved, submitForReview, type Ctx,
} from '@social-lite/services';

const cfg = config();
if (cfg.APP_ENV === 'production') throw new Error('Refusing to seed demo data in production');
const args = process.argv.slice(2);
const wsName = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? 'Demo Workspace';
const volIdx = args.indexOf('--volume');
const volume = volIdx >= 0 ? Number(args[volIdx + 1] ?? 0) : 0;
const TITLE = 'Spring menu launch (collaboration demo)';

async function ctxFor(email: string, workspaceId: string): Promise<Ctx> {
  const u = await maybeOne<{ id: string; name: string | null }>(getPool(), `SELECT id, name FROM users WHERE email=$1`, [email]);
  if (!u) throw new Error(`user ${email} not found`);
  const access = await loadAccess(u.id, workspaceId, getPool(), { mfaVerified: true, authTime: new Date().toISOString() });
  if (!access) throw new Error(`${email} has no access to ${wsName}`);
  return { actor: { userId: u.id, email, name: u.name, sessionId: randomUUID() }, access, correlationId: randomUUID() };
}

async function main() {
  const db = getPool();
  const ws = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name=$1 AND is_demo`, [wsName]);
  if (!ws) throw new Error(`${wsName} not found (synthetic demo workspaces only)`);
  const owner = await ctxFor('owner@demo.social-lite.test', ws.id);
  const editor = await ctxFor('editor@demo.social-lite.test', ws.id);
  const approver = await ctxFor('approver@demo.social-lite.test', ws.id);
  const brand = await maybeOne<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1 AND name LIKE 'Vitalos%' AND archived_at IS NULL LIMIT 1`, [ws.id]);
  if (!brand) throw new Error('Vitalos (demo) brand not found');
  let post = await maybeOne<{ id: string }>(db, `SELECT id FROM posts WHERE workspace_id=$1 AND title=$2 AND deleted_at IS NULL`, [ws.id, TITLE]);
  if (!post) {
    const conns = await many<{ id: string }>(db, `SELECT id FROM connections WHERE brand_id=$1 AND disconnected_at IS NULL AND status='ready' AND display_name NOT LIKE '%rejects%' ORDER BY provider LIMIT 2`, [brand.id]);
    const draft = {
      baseText: 'Spring menu is here 🌱 Fresh peas, wild garlic and our new lemon tart. Book a table this weekend and try all three.',
      baseLink: 'https://example.com/spring', baseAssetIds: [] as string[],
      variants: conns.map((c) => ({ connectionId: c.id, inheritText: true, inheritMedia: true })),
    };
    post = await createPost(editor, brand.id, { title: TITLE, draft }, randomUUID());
    const ids = { approver: approver.actor.userId, owner: owner.actor.userId, editor: editor.actor.userId };
    const t1 = await createThread(editor, post.id, { visibility: 'internal', body: `Can we tighten the first line? @[${ids.approver}] what do you think?`,
      anchor: { kind: 'text', field: 'base', quote: 'Spring menu is here', prefix: '', suffix: ' 🌱' } });
    await replyToThread(approver, t1.thread.id, { body: 'Agree. Lead with the **lemon tart** — it’s the hero.' });
    await replyToThread(owner, t1.thread.id, { body: `Fine by me. @[${ids.editor}] go ahead.` });
    const t2 = await createThread(owner, post.id, { visibility: 'shared', body: 'Client asked for prices to be visible. Can we add “from £6”?' });
    void t2;
    const t3 = await createThread(approver, post.id, { visibility: 'internal', body: 'Link checked — UTM tags are in place.' });
    await setThreadResolved(approver, t3.thread.id, true);
    const day = 86_400_000;
    await createTask(owner, { post_id: post.id, title: 'Shorten the caption for X', assignee_id: ids.editor, due_at: new Date(Date.now() + day).toISOString(), due_timezone: 'Europe/London', priority: 'high' });
    await createTask(editor, { post_id: post.id, title: 'Check image alt text', assignee_id: ids.approver, due_at: new Date(Date.now() - day / 2).toISOString(), due_timezone: 'Europe/London' });
    await createTask(owner, { post_id: post.id, title: 'Confirm prices with the client', due_at: new Date(Date.now() + 3 * day).toISOString(), due_timezone: 'Europe/London', priority: 'normal' });
    // A review request on the brand that requires approval (scheduled 5 days out; simulated destinations only).
    const ts = await maybeOne<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1 AND approval_required AND archived_at IS NULL LIMIT 1`, [ws.id]);
    const tconn = ts ? await maybeOne<{ id: string }>(db, `SELECT id FROM connections WHERE brand_id=$1 AND provider='telegram' AND disconnected_at IS NULL LIMIT 1`, [ts.id]) : null;
    if (ts && tconn) {
      const p2 = await createPost(editor, ts.id, { title: 'Weekend picks (review demo)', draft: { baseText: 'Our three picks for the weekend are live in the app.', baseLink: null, baseAssetIds: [], variants: [{ connectionId: tconn.id, inheritText: true, inheritMedia: true }] } }, randomUUID());
      const local = new Date(Date.now() + 5 * day).toISOString().slice(0, 16);
      const sub = await submitForReview(editor, p2.id, { expected_version: 1, connection_ids: [tconn.id], input_local_time: local, timezone: 'Europe/London' }, randomUUID());
      const approvalId = (sub.body as { approval: { id: string } }).approval.id;
      await requestReviewers(editor, approvalId, [ids.approver]).catch(() => undefined);
      await createThread(editor, p2.id, { visibility: 'internal', body: `@[${ids.approver}] this one needs a quick look before Friday.`, approval_id: approvalId });
      await createTask(editor, { approval_id: approvalId, title: 'Review weekend picks', assignee_id: ids.approver, due_at: new Date(Date.now() + 2 * day).toISOString(), due_timezone: 'Europe/London', priority: 'urgent' });
    }
    console.log(JSON.stringify({ msg: 'collaboration demo seeded', workspace: wsName, postId: post.id }));
  } else console.log(JSON.stringify({ msg: 'collaboration demo already present', workspace: wsName, postId: post.id }));

  if (volume > 0) {
    // Volume goes on its own synthetic post so the demo post stays readable.
    const VT = 'Collaboration volume (synthetic)';
    let vp = await maybeOne<{ id: string }>(db, `SELECT id FROM posts WHERE workspace_id=$1 AND title=$2 AND deleted_at IS NULL`, [ws.id, VT]);
    if (!vp) vp = await createPost(editor, brand.id, { title: VT, draft: { baseText: 'Volume test post (synthetic).', baseLink: null, baseAssetIds: [], variants: [] } }, randomUUID());
    post = vp;
    await db.query(`DELETE FROM rate_limit_buckets WHERE key LIKE 'collab.%'`);
    const t0 = Date.now();
    for (let i = 0; i < volume; i++) {
      const who = [owner, editor, approver][i % 3]!;
      await db.query(`DELETE FROM rate_limit_buckets WHERE key LIKE 'collab.%'`);
      const th = await createThread(who, post.id, { visibility: i % 4 === 0 ? 'shared' : 'internal', body: `Volume thread ${i + 1}: check line ${i % 7 + 1}.` });
      for (let r = 0; r < 3; r++) await replyToThread([editor, approver, owner][(i + r) % 3]!, th.thread.id, { body: `Reply ${r + 1} on ${i + 1}` });
      await createTask(who, { post_id: post.id, title: `Volume task ${i + 1}`, assignee_id: [editor, approver][i % 2]!.actor.userId, due_at: new Date(Date.now() + ((i % 10) - 3) * 86_400_000).toISOString(), due_timezone: 'Europe/London' });
    }
    console.log(JSON.stringify({ msg: 'volume added', threads: volume, replies: volume * 3, tasks: volume, ms: Date.now() - t0 }));
  }
}

main().then(() => closePool()).catch(async (err) => { console.error(err); await closePool(); process.exit(1); });
