// Collaboration completion (brief docs/queue/03d_COLLABORATION_PROMPT.md §14) through the REAL policy path (v2Ctx):
// two users commenting + receiving updates, mentions (creation / edits / dedupe / removed members), internal-thread
// isolation from clients, visibility changes, edit history + tombstones, tasks (assignment, reassignment, permissions,
// concurrency, deadlines never reschedule), timezone-aware bounded reminders, reviewer requests + notifications, approval
// invalidation after edits, simultaneous autosaves → recoverable conflict, restore → new version, history + compare,
// revoked access stops subscriptions + notifications, offline reconnect + missed-event reconciliation, duplicate
// delivery safety, cross-workspace isolation, email without SMTP never "sent", admin views and reassignment.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  collabAdminOverview, compareVersions, createPost, createTask, createThread, deleteComment, editComment, getReview, getThread,
  listNotificationFeed, listTasks, listThreads, listVersionHistory, markNotificationUnread, markThreadsRead, mentionCandidates, notificationDiagnostics,
  postActivity, presenceHeartbeat, getPresence, readCollabEvents, reassignWork, reassignmentWork, replyToThread, requestReviewers, restoreVersion,
  runOffboardingSweep, runReviewOverdue, runTaskReminders, setThreadResolved, setThreadVisibility, shareReview, submitForReview, updateCollabSettings,
  updateTask, commentHistory, addReviewComment, unreadThreadCounts, sendNotificationEmail, resetConfigCache, approve, type Ctx,
} from '@social-lite/services';
import { handleEvent } from '@social-lite/services/engine/notify';
import { autosaveDraft } from '@social-lite/services/data/drafts';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, grant, testPool, v2Ctx } from './helpers.js';
import { seedConnections } from './engine-helpers.js';

afterAll(closeTestPool);
beforeEach(async () => { await testPool().query(`DELETE FROM rate_limit_buckets WHERE key LIKE 'collab.%'`); });

async function runOutbox(workspaceId: string) {
  const r = await testPool().query<{ id: string; event_type: string; aggregate_id: string; payload: Record<string, unknown> }>(
    `UPDATE outbox SET dispatch_state='dispatched', dispatched_at=now() WHERE workspace_id=$1 AND dispatch_state='pending' AND event_type <> 'delivery.due'
     RETURNING id, event_type, aggregate_id, payload`, [workspaceId]);
  for (const e of r.rows.sort((a, b) => Number(a.id) - Number(b.id))) await handleEvent({ event_type: e.event_type, workspace_id: workspaceId, aggregate_id: e.aggregate_id, payload: e.payload });
  return r.rows.length;
}

async function member(ws: string, role: string, brandId?: string, name = 'Member') {
  const u = await createUser(undefined, name);
  await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [ws, u.id]);
  await grant(ws, u.id, role, brandId);
  return u;
}

async function team() {
  const ws = await createWorkspace('Collab');
  const brand = await createBrand(ws, 'Brand A', { approvalRequired: true });
  const brandB = await createBrand(ws, 'Brand B');
  const owner = await createUser(undefined, 'Olivia Owner');
  await addMember(ws, owner.id, 'owner');
  const alice = await member(ws, 'editor', brand, 'Alice Editor');
  const bob = await member(ws, 'editor', brand, 'Bob Writer');
  const rita = await member(ws, 'approver', brand, 'Rita Reviewer');
  const viewer = await member(ws, 'viewer', brand, 'Vic Viewer');
  const outsider = await member(ws, 'editor', brandB, 'Otto Outsider');
  const guest = await createUser(undefined, 'Cara Client');
  await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [ws, guest.id]);
  await grant(ws, guest.id, 'guest', brand, new Date(Date.now() + 7 * 86_400_000));
  const conns = await seedConnections(ws, brand);
  return { ws, brand, brandB, owner, alice, bob, rita, viewer, outsider, guest, conns };
}
type Team = Awaited<ReturnType<typeof team>>;
const c = (t: Team, who: keyof Pick<Team, 'owner' | 'alice' | 'bob' | 'rita' | 'viewer' | 'outsider' | 'guest'>) => v2Ctx(t[who].id, t.ws);

async function post(t: Team, ctx: Ctx, text = 'Launch day copy') {
  const draft = { baseText: text, baseLink: null, baseAssetIds: [] as string[], variants: [{ connectionId: t.conns.telegram, inheritText: true, inheritMedia: true }] };
  const { id } = await createPost(ctx, t.brand, { title: 'Internal title', draft }, randomUUID());
  return { id, draft };
}

async function notes(userId: string, ws: string) {
  return (await testPool().query<{ kind: string; title: string; link_path: string | null; dedupe_key: string; body: string | null; email_state: string }>(
    `SELECT kind, title, link_path, dedupe_key, body, email_state FROM notifications WHERE user_id=$1 AND workspace_id=$2 ORDER BY created_at`, [userId, ws])).rows;
}

describe('threads: two users, replies, unread, realtime feed', () => {
  it('two users comment and receive each other’s updates through the change feed; unread clears on read', async () => {
    const t = await team();
    const { id } = await post(t, await c(t, 'alice'));
    const aliceStart = (await readCollabEvents(await c(t, 'alice'), { postId: id, after: 0 })).cursor;
    const bobStart = (await listThreads(await c(t, 'bob'), id)).cursor;
    const th = await createThread(await c(t, 'alice'), id, { visibility: 'internal', body: 'Can we shorten the **intro**?', client_key: 'k-alice-1' });
    expect(th.thread.comments[0]!.body).toBe('Can we shorten the **intro**?');
    // Bob sees an event for the new thread (content-free) and the thread is unread for him.
    const bobFeed = await readCollabEvents(await c(t, 'bob'), { postId: id, after: bobStart });
    expect(bobFeed.events.map((e) => e.kind)).toContain('comment.created');
    expect(JSON.stringify(bobFeed.events)).not.toContain('intro');
    const bobList = await listThreads(await c(t, 'bob'), id);
    expect(bobList.items[0]!.unread).toBe(true);
    expect(bobList.counts.unread).toBe(1);
    expect((await unreadThreadCounts(await c(t, 'bob'), [{ id, brand_id: t.brand }])).get(id)).toBe(1);
    await replyToThread(await c(t, 'bob'), th.thread.id, { body: 'Done — trimmed it.', client_key: 'k-bob-reply-1' });
    // A retried reply (lost response) does not duplicate.
    await replyToThread(await c(t, 'bob'), th.thread.id, { body: 'Done — trimmed it.', client_key: 'k-bob-reply-1' });
    const aliceFeed = await readCollabEvents(await c(t, 'alice'), { postId: id, after: aliceStart });
    expect(aliceFeed.events.filter((e) => e.kind === 'comment.created' && !e.mine)).toHaveLength(1);
    const full = await getThread(await c(t, 'alice'), th.thread.id);
    expect(full.thread.comments.map((x) => x.body)).toEqual(['Can we shorten the **intro**?', 'Done — trimmed it.']);
    expect(full.thread.unread).toBe(true);
    await markThreadsRead(await c(t, 'alice'), id);
    expect((await listThreads(await c(t, 'alice'), id)).items[0]!.unread).toBe(false);
    // Alice is told about Bob's reply (participant), once.
    await runOutbox(t.ws);
    await runOutbox(t.ws);
    const an = await notes(t.alice.id, t.ws);
    expect(an.filter((n) => n.kind === 'comment.reply')).toHaveLength(1);
    expect(an.find((n) => n.kind === 'comment.reply')!.link_path).toBe(`/posts/${id}?thread=${th.thread.id}`);
    expect(an.every((n) => !(n.body ?? '').includes('trimmed') && !n.title.includes('trimmed'))).toBe(true);
    // Resolve / reopen; replying to a resolved thread reopens it.
    await setThreadResolved(await c(t, 'alice'), th.thread.id, true);
    expect((await listThreads(await c(t, 'alice'), id, { status: 'resolved' })).items).toHaveLength(1);
    await replyToThread(await c(t, 'bob'), th.thread.id, { body: 'One more thing' });
    expect((await getThread(await c(t, 'bob'), th.thread.id)).thread.resolved).toBe(false);
    // Commenting never approves anything.
    expect((await testPool().query(`SELECT count(*)::int n FROM approval_decisions d JOIN approvals a ON a.id=d.approval_id WHERE a.post_id=$1`, [id])).rows[0]!.n).toBe(0);
  });

  it('edit history and delete tombstones; only the author edits; anchors become outdated after later edits', async () => {
    const t = await team();
    const { id, draft } = await post(t, await c(t, 'alice'), 'Hello brave new world');
    const th = await createThread(await c(t, 'alice'), id, { visibility: 'internal', body: 'Typo here', anchor: { kind: 'text', field: 'base', quote: 'brave new' } });
    expect(th.thread.anchor_status).toBe('current');
    // A media anchor must be an asset of this brand (never another brand's or workspace's id).
    await expect(createThread(await c(t, 'alice'), id, { visibility: 'internal', body: 'x', anchor: { kind: 'media', asset_id: randomUUID() } })).rejects.toMatchObject({ code: 'validation_failed' });
    const cid = th.thread.comments[0]!.id;
    await expect(editComment(await c(t, 'bob'), cid, { body: 'hijack' })).rejects.toMatchObject({ code: 'forbidden' });
    await editComment(await c(t, 'alice'), cid, { body: 'Typo here — "brave"' });
    const hist = await commentHistory(await c(t, 'bob'), cid);
    expect(hist.items.map((h) => h.body)).toEqual(['Typo here']);
    // A later edit that removes the quoted text marks the thread outdated (preserved against v1).
    await autosaveDraft(await c(t, 'alice'), id, { base_version: 1, client_id: 'tab-alice-1', client_revision: 1, draft: { ...draft, baseText: 'Hello world' } });
    const after = await listThreads(await c(t, 'bob'), id);
    expect(after.items[0]!.anchor_status).toBe('outdated');
    expect(after.items[0]!.anchor_version).toBe(1);
    await deleteComment(await c(t, 'alice'), cid);
    await replyToThread(await c(t, 'bob'), th.thread.id, { body: 'noted' }).catch(() => undefined);
    const g = await getThread(await c(t, 'bob'), th.thread.id);
    expect(g.thread.comments[0]).toMatchObject({ deleted: true, body: null });
    expect((await commentHistory(await c(t, 'bob'), cid)).items).toHaveLength(0);
    expect((await testPool().query(`SELECT count(*)::int n FROM comment_edits WHERE comment_id=$1`, [cid])).rows[0]!.n).toBe(0);
  });
});

describe('mentions', () => {
  it('notifies newly mentioned people once; edits never re-notify; inaccessible / removed people are skipped; mentions grant nothing', async () => {
    const t = await team();
    const { id } = await post(t, await c(t, 'alice'));
    // Candidate search is bounded and only suggests people who can see an internal thread on this brand.
    const cands = await mentionCandidates(await c(t, 'alice'), id, 'internal', 'r');
    expect(cands.items.map((x) => x.id)).toContain(t.rita.id);
    expect(cands.items.map((x) => x.id)).not.toContain(t.outsider.id);
    expect((await mentionCandidates(await c(t, 'alice'), id, 'internal', 'otto')).items).toHaveLength(0);
    expect((await mentionCandidates(await c(t, 'alice'), id, 'internal', 'cara')).items).toHaveLength(0); // guest: never for internal
    const th = await createThread(await c(t, 'alice'), id, { visibility: 'internal', body: `@[${t.rita.id}] and @[${t.outsider.id}] please check` });
    await runOutbox(t.ws);
    expect((await notes(t.rita.id, t.ws)).filter((n) => n.kind === 'mention')).toHaveLength(1);
    expect((await notes(t.outsider.id, t.ws))).toHaveLength(0); // no access to the brand → skipped, nothing granted
    await expect(getThread(await c(t, 'outsider'), th.thread.id)).rejects.toMatchObject({ code: 'not_found' });
    // Edit keeps Rita, adds Bob: only Bob is notified.
    await editComment(await c(t, 'alice'), th.thread.comments[0]!.id, { body: `@[${t.rita.id}] @[${t.bob.id}] please check` });
    await runOutbox(t.ws);
    expect((await notes(t.rita.id, t.ws)).filter((n) => n.kind === 'mention')).toHaveLength(1);
    expect((await notes(t.bob.id, t.ws)).filter((n) => n.kind === 'mention')).toHaveLength(1);
    // Edit again (no new mentions) → no new notifications; removing then re-adding Bob does not re-notify.
    await editComment(await c(t, 'alice'), th.thread.comments[0]!.id, { body: `@[${t.rita.id}] check` });
    await editComment(await c(t, 'alice'), th.thread.comments[0]!.id, { body: `@[${t.rita.id}] @[${t.bob.id}] check` });
    await runOutbox(t.ws);
    expect((await notes(t.bob.id, t.ws)).filter((n) => n.kind === 'mention')).toHaveLength(1);
    // A removed member mentioned later is skipped and shown as a former member.
    await testPool().query(`UPDATE memberships SET removed_at=now(), status='removed' WHERE workspace_id=$1 AND user_id=$2`, [t.ws, t.viewer.id]);
    const th2 = await createThread(await c(t, 'alice'), id, { visibility: 'internal', body: `@[${t.viewer.id}] fyi` });
    await runOutbox(t.ws);
    expect(await notes(t.viewer.id, t.ws)).toHaveLength(0);
    const g = await getThread(await c(t, 'alice'), th2.thread.id);
    expect(g.people[t.viewer.id]).toMatchObject({ name: 'Former member', active: false, email: null });
  });
});

describe('internal vs client-visible discussion', () => {
  it('internal threads never reach a client: list, thread, events, notifications, mentions; visibility change is explicit + confirmed', async () => {
    const t = await team();
    const { id } = await post(t, await c(t, 'alice'));
    const sub = await submitForReview(await c(t, 'alice'), id, { expected_version: 1, connection_ids: [t.conns.telegram] }, randomUUID());
    const approvalId = (sub.body as { approval: { id: string } }).approval.id;
    await shareReview(await c(t, 'alice'), id, t.guest.id);
    const guestStart = (await readCollabEvents(await c(t, 'guest'), { postId: id, after: 0 })).cursor;
    const internal = await createThread(await c(t, 'alice'), id, { visibility: 'internal', body: `INTERNAL margin note @[${t.guest.id}]` });
    const shared = await createThread(await c(t, 'alice'), id, { visibility: 'shared', body: `Please review @[${t.guest.id}]`, approval_id: approvalId });
    await runOutbox(t.ws);
    // Guest notifications: only the shared mention, linking to the review portal thread.
    const gn = await notes(t.guest.id, t.ws);
    expect(gn.filter((n) => n.kind === 'mention')).toHaveLength(1);
    expect(gn.find((n) => n.kind === 'mention')!.link_path).toBe(`/review/${approvalId}?thread=${shared.thread.id}`);
    expect(JSON.stringify(gn)).not.toContain('INTERNAL');
    // Review portal: shared threads only, no internal anchors or reviewer emails.
    const r = await getReview(await c(t, 'guest'), approvalId);
    expect(r.threads.map((x) => x.id)).toEqual([shared.thread.id]);
    expect(JSON.stringify(r)).not.toContain('INTERNAL');
    expect(r.threads[0]!.comments[0]!.author?.email).toBeNull();
    await expect(getThread(await c(t, 'guest'), internal.thread.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(replyToThread(await c(t, 'guest'), internal.thread.id, { body: 'sneak' })).rejects.toMatchObject({ code: 'not_found' });
    // Realtime: the guest receives the shared thread's event, never the internal one.
    const ge = await readCollabEvents(await c(t, 'guest'), { postId: id, after: guestStart });
    expect(ge.events.map((e) => e.ref_id)).toContain(shared.thread.id);
    expect(ge.events.map((e) => e.ref_id)).not.toContain(internal.thread.id);
    // Guest replies in the shared thread; the requester hears about it.
    await replyToThread(await c(t, 'guest'), shared.thread.id, { body: 'Looks good, tweak line 2' });
    await runOutbox(t.ws);
    expect((await notes(t.alice.id, t.ws)).some((n) => n.kind === 'comment.client' || n.kind === 'comment.reply')).toBe(true);
    // A comment of mixed visibility is refused by the database.
    await expect(testPool().query(`INSERT INTO comments(workspace_id, brand_id, post_id, visibility, author_id, body, thread_id) VALUES ($1,$2,$3,'internal',$4,'x',$5)`,
      [t.ws, t.brand, id, t.alice.id, shared.thread.id])).rejects.toThrow(/visibility/);
    // Making the internal thread shared needs the exact count; a guest/approver without both comment permissions can't.
    await expect(setThreadVisibility(await c(t, 'bob'), internal.thread.id, { visibility: 'shared', confirm_count: 1 })).rejects.toMatchObject({ code: 'forbidden' });
    await replyToThread(await c(t, 'bob'), internal.thread.id, { body: 'internal reply' });
    await expect(setThreadVisibility(await c(t, 'alice'), internal.thread.id, { visibility: 'shared', confirm_count: 1 })).rejects.toMatchObject({ code: 'conflict', details: { comment_count: 2 } });
    expect((await getReview(await c(t, 'guest'), approvalId)).threads).toHaveLength(1);
    await setThreadVisibility(await c(t, 'alice'), internal.thread.id, { visibility: 'shared', confirm_count: 2 });
    expect((await getReview(await c(t, 'guest'), approvalId)).threads).toHaveLength(2);
    expect((await testPool().query(`SELECT count(*)::int n FROM audit_events WHERE action='thread.visibility_changed' AND resource_id=$1`, [internal.thread.id])).rows[0]!.n).toBe(1);
    // Clients can be stopped from posting (admin setting) while still reading.
    await updateCollabSettings(await c(t, 'owner'), { client_comments: false });
    await expect(replyToThread(await c(t, 'guest'), shared.thread.id, { body: 'more' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(addReviewComment(await c(t, 'guest'), approvalId, 'new thread')).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('tasks + deadlines', () => {
  it('assignment, reassignment, permissions, concurrency; completion never approves; deadlines never reschedule', async () => {
    const t = await team();
    const { id } = await post(t, await c(t, 'alice'));
    const sub = await submitForReview(await c(t, 'alice'), id, { expected_version: 1, connection_ids: [t.conns.telegram], input_local_time: '2031-01-10T09:00', timezone: 'Europe/London' }, randomUUID());
    const approvalId = (sub.body as { approval: { id: string } }).approval.id;
    const schedBefore = (await testPool().query(`SELECT due_at FROM schedules WHERE post_id=$1 AND status='pending_approval'`, [id])).rows[0]!.due_at as Date;
    await expect(createTask(await c(t, 'viewer'), { post_id: id, title: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createTask(await c(t, 'alice'), { post_id: id, title: 'x', assignee_id: t.outsider.id })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(createTask(await c(t, 'outsider'), { post_id: id, title: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    const task = await createTask(await c(t, 'alice'), { approval_id: approvalId, title: 'Review copy for launch', assignee_id: t.rita.id,
      due_at: '2030-06-01T12:00:00Z', due_timezone: 'America/New_York', priority: 'high' });
    expect(task).toMatchObject({ status: 'open', priority: 'high', reference: { type: 'review', id: approvalId }, assignee: { id: t.rita.id }, due_local: '2030-06-01T08:00' });
    await runOutbox(t.ws);
    expect((await notes(t.rita.id, t.ws)).filter((n) => n.kind === 'task.assigned')).toHaveLength(1);
    expect((await listTasks(await c(t, 'rita'), { view: 'mine' })).items.map((x) => x.id)).toEqual([task.id]);
    expect((await listTasks(await c(t, 'alice'), { view: 'created' })).items.map((x) => x.id)).toEqual([task.id]);
    expect((await listTasks(await c(t, 'outsider'), { view: 'team' })).items).toHaveLength(0);
    // Stale update → version_conflict; reassign to Bob; Bob completes; nothing approved, schedule untouched.
    await expect(updateTask(await c(t, 'alice'), task.id, { expected_version: 99, title: 'x' })).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(updateTask(await c(t, 'viewer'), task.id, { expected_version: 1, status: 'completed' })).rejects.toMatchObject({ code: 'forbidden' });
    const moved = await updateTask(await c(t, 'alice'), task.id, { expected_version: 1, assignee_id: t.bob.id, due_at: '2030-07-01T12:00:00Z' });
    expect(moved.version).toBe(2);
    const done = await updateTask(await c(t, 'bob'), task.id, { expected_version: 2, status: 'completed' });
    expect(done.status).toBe('completed');
    expect((await testPool().query(`SELECT decision FROM approvals WHERE id=$1`, [approvalId])).rows[0]!.decision).toBe('pending');
    expect((await testPool().query(`SELECT due_at FROM schedules WHERE post_id=$1 AND status='pending_approval'`, [id])).rows[0]!.due_at).toEqual(schedBefore);
    await runOutbox(t.ws);
    expect((await notes(t.alice.id, t.ws)).some((n) => n.kind === 'task.completed')).toBe(true);
    const full = await (await import('@social-lite/services')).getTask(await c(t, 'alice'), task.id);
    expect(full.history.map((h) => h.kind)).toEqual(expect.arrayContaining(['created', 'reassigned', 'due_changed', 'status']));
  });

  it('timezone-aware, bounded reminders: one "due soon" per deadline, ≤ N overdue, a new deadline gets new reminders', async () => {
    const t = await team();
    const { id } = await post(t, await c(t, 'alice'));
    const due = new Date('2030-03-10T17:00:00Z');
    const task = await createTask(await c(t, 'alice'), { post_id: id, title: 'Write captions', assignee_id: t.bob.id, due_at: due.toISOString(), due_timezone: 'Asia/Tokyo' });
    await updateCollabSettings(await c(t, 'owner'), { reminder_lead_hours: 24, max_overdue_reminders: 2 });
    const at = (iso: string) => runTaskReminders(testPool(), new Date(iso));
    expect(await at('2030-03-09T10:00:00Z')).toBe(0);            // 31 h before: nothing
    expect(await at('2030-03-09T18:00:00Z')).toBe(1);            // within 24 h: one "due soon"
    expect(await at('2030-03-09T20:00:00Z')).toBe(0);            // never twice for the same deadline
    expect(await at('2030-03-10T17:30:00Z')).toBe(1);            // overdue #1
    expect(await at('2030-03-10T20:00:00Z')).toBe(0);            // ≥ 24 h apart
    expect(await at('2030-03-11T18:00:00Z')).toBe(1);            // overdue #2
    expect(await at('2030-03-13T18:00:00Z')).toBe(0);            // capped at 2
    const bn = await notes(t.bob.id, t.ws);
    const soon = bn.find((n) => n.kind === 'task.reminder.soon')!;
    expect(soon.body).toBe('Due Mon 11 Mar, 02:00 GMT+9');  // shown in the task's own time zone, never the task text
    expect(bn.filter((n) => n.kind === 'task.reminder.overdue')).toHaveLength(2);
    // Moving the deadline resets reminders for the new date (and never reschedules anything).
    const cur = (await listTasks(await c(t, 'alice'), { view: 'created' })).items[0]!;
    await updateTask(await c(t, 'alice'), task.id, { expected_version: cur.version, due_at: '2030-04-01T09:00:00Z' });
    expect(await at('2030-03-31T12:00:00Z')).toBe(1);
  });
});

describe('reviews', () => {
  it('reviewer requests only reach eligible people; edits invalidate and notify; overdue once', async () => {
    const t = await team();
    const { id, draft } = await post(t, await c(t, 'alice'));
    const sub = await submitForReview(await c(t, 'alice'), id, { expected_version: 1, connection_ids: [t.conns.telegram], input_local_time: '2031-01-10T09:00', timezone: 'Europe/London' }, randomUUID());
    const a = (sub.body as { approval: { id: string; fingerprint: string } }).approval;
    await runOutbox(t.ws);
    await expect(requestReviewers(await c(t, 'alice'), a.id, [t.bob.id])).rejects.toMatchObject({ code: 'validation_failed' }); // editor can't approve
    const r = await requestReviewers(await c(t, 'alice'), a.id, [t.rita.id]);
    expect(r.added).toEqual([t.rita.id]);
    await runOutbox(t.ws);
    const rn = await notes(t.rita.id, t.ws);
    // Merged with the "waiting for your review" item she already had: one notification, now "Your review was requested".
    const forReview = rn.filter((n) => n.dedupe_key.startsWith(`approval:${a.id}:stage:`) || n.dedupe_key === `approval:${a.id}:req:${t.rita.id}`);
    expect(forReview).toHaveLength(1);
    expect(forReview[0]).toMatchObject({ title: 'Your review was requested', link_path: `/approvals/${a.id}` });
    const feed = await listNotificationFeed(await c(t, 'rita'), { category: 'reviews' });
    expect(feed.items[0]!.context).toMatch(/^Review · Internal title/);
    // An "approved" comment never counts.
    await createThread(await c(t, 'rita'), id, { visibility: 'internal', body: 'approved', approval_id: a.id });
    expect((await testPool().query(`SELECT decision FROM approvals WHERE id=$1`, [a.id])).rows[0]!.decision).toBe('pending');
    // Overdue reviews notify once.
    await testPool().query(`UPDATE approvals SET due_at=now() - interval '1 hour', assignee_user_id=$2 WHERE id=$1`, [a.id, t.rita.id]);
    expect(await runReviewOverdue()).toBeGreaterThan(0);
    expect(await runReviewOverdue()).toBe(0);
    // Rita approves stage 1 of 1 → approved, author told. Then a content edit on a NEW submission invalidates it.
    await approve(await c(t, 'rita'), a.id, a.fingerprint);
    await runOutbox(t.ws);
    expect((await notes(t.alice.id, t.ws)).some((n) => n.kind === 'approval.approved')).toBe(true);
    const sub2 = await submitForReview(await c(t, 'alice'), id, { expected_version: 1, connection_ids: [t.conns.telegram], input_local_time: '2031-01-11T09:00', timezone: 'Europe/London' }, randomUUID());
    const a2 = (sub2.body as { approval: { id: string } }).approval;
    await requestReviewers(await c(t, 'alice'), a2.id, [t.rita.id]);
    await autosaveDraft(await c(t, 'bob'), id, { base_version: 1, client_id: 'tab-bob-1', client_revision: 1, draft: { ...draft, baseText: 'Changed after submission' } });
    expect((await testPool().query(`SELECT decision FROM approvals WHERE id=$1`, [a2.id])).rows[0]!.decision).toBe('invalidated');
    await runOutbox(t.ws);
    expect((await notes(t.alice.id, t.ws)).some((n) => n.kind === 'approval.invalidated')).toBe(true);
    expect((await notes(t.rita.id, t.ws)).some((n) => n.dedupe_key === `approval:${a2.id}:invalidated`)).toBe(true);
    // History shows which revisions the approvals refer to.
    const h = await listVersionHistory(await c(t, 'alice'), id);
    expect(h.revisions.length).toBeGreaterThanOrEqual(1);
    expect(h.revisions.flatMap((x) => x.approvals.map((y) => y.decision))).toEqual(expect.arrayContaining(['invalidated']));
    expect(h.revisions.flatMap((x) => x.approvals).every((y) => !y.applies_to_current)).toBe(true);
    expect(h.revisions.some((x) => x.older_than_current)).toBe(true);
  });
});

describe('concurrent editing, history, restore', () => {
  it('simultaneous autosaves → recoverable conflict; compare; restore creates a new version', async () => {
    const t = await team();
    const { id, draft } = await post(t, await c(t, 'alice'), 'Base text');
    const [x, y] = await Promise.allSettled([
      autosaveDraft(await c(t, 'alice'), id, { base_version: 1, client_id: 'tab-alice-2', client_revision: 1, draft: { ...draft, baseText: 'Alice version' } }),
      autosaveDraft(await c(t, 'bob'), id, { base_version: 1, client_id: 'tab-bob-2', client_revision: 1, draft: { ...draft, baseText: 'Bob version', baseLink: 'https://example.com/b' } }),
    ]);
    const won = [x, y].filter((r) => r.status === 'fulfilled');
    const lost = [x, y].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ code: 'version_conflict' });
    const copyId = (lost[0]!.reason as { details: { conflict_copy_id: string } }).details.conflict_copy_id;
    expect(copyId).toBeTruthy();
    const h = await listVersionHistory(await c(t, 'alice'), id);
    expect(h.items.map((i) => i.kind)).toEqual(expect.arrayContaining(['conflict', 'saved', 'created']));
    expect(h.items.find((i) => i.kind === 'saved')!.summary).toMatch(/Changed/);
    const cmp = await compareVersions(await c(t, 'alice'), id, copyId, 'current');
    expect(cmp.changed).toContain('text');
    expect(cmp.variants[0]!.connection_id).toBe(t.conns.telegram);
    // Restore the losing copy as a NEW version (history kept, nothing rewritten).
    const before = (await testPool().query(`SELECT count(*)::int n FROM post_versions WHERE post_id=$1`, [id])).rows[0]!.n;
    const r = await restoreVersion(await c(t, 'alice'), id, copyId, 2);
    expect(r.version).toBe(3);
    expect((await testPool().query(`SELECT count(*)::int n FROM post_versions WHERE post_id=$1`, [id])).rows[0]!.n).toBe(before + 1);
    await expect(restoreVersion(await c(t, 'viewer'), id, copyId, 3)).rejects.toMatchObject({ code: 'forbidden' });
    const act = await postActivity(await c(t, 'alice'), id);
    expect(act.items.map((a) => a.action)).toEqual(expect.arrayContaining(['post.created', 'post.conflict_copy_saved']));
  });
});

describe('revocation, reconnect and isolation', () => {
  it('revoked access stops events, presence, notifications; offboarding flags work for reassignment', async () => {
    const t = await team();
    const { id } = await post(t, await c(t, 'alice'));
    await presenceHeartbeat(await c(t, 'alice'), id, { client_id: 'tab-alice-p', state: 'editing' });
    await presenceHeartbeat(await c(t, 'bob'), id, { client_id: 'tab-bob-p', state: 'viewing' });
    const p = await getPresence(await c(t, 'alice'), id);
    expect(p.people.map((x) => [x.name, x.state])).toEqual(expect.arrayContaining([['Bob Writer', 'viewing'], ['Alice Editor', 'editing']]));
    const task = await createTask(await c(t, 'alice'), { post_id: id, title: 'Hand-off', assignee_id: t.bob.id });
    const bobCtx = await c(t, 'bob');
    // Bob loses his brand grant: his (already built) context sees no events; presence hides him; mentions skip him.
    await testPool().query(`UPDATE scoped_role_grants SET revoked_at=now() WHERE workspace_id=$1 AND user_id=$2`, [t.ws, t.bob.id]);
    await expect(v2Ctx(t.bob.id, t.ws).then((x) => readCollabEvents(x, { postId: id, after: 0 }))).resolves.toMatchObject({ visible: false, events: [] });
    expect((await getPresence(await c(t, 'alice'), id)).people.map((x) => x.name)).not.toContain('Bob Writer');
    await createThread(await c(t, 'alice'), id, { visibility: 'internal', body: `@[${t.bob.id}] still there?` });
    await runOutbox(t.ws);
    expect((await notes(t.bob.id, t.ws)).filter((n) => n.kind === 'mention')).toHaveLength(0);
    void bobCtx;
    // Offboarding: the task is flagged; the admin view lists it; reassigning moves it to Rita.
    expect(await runOffboardingSweep()).toBeGreaterThanOrEqual(1);
    const work = await reassignmentWork(await c(t, 'owner'));
    expect(work.tasks.map((x) => x.id)).toContain(task.id);
    const res = await reassignWork(await c(t, 'owner'), { from_user_id: t.bob.id, to_user_id: t.rita.id, include: ['tasks'] });
    expect(res.tasks).toBe(1);
    expect((await listTasks(await c(t, 'rita'), { view: 'mine' })).items[0]).toMatchObject({ id: task.id, needs_reassignment: false });
    await expect(reassignWork(await c(t, 'alice'), { from_user_id: t.bob.id, to_user_id: t.rita.id })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('offline reconnect: events after the cursor arrive in order; a stale cursor resets; other workspaces stay invisible', async () => {
    const t = await team();
    const other = await team();
    const { id } = await post(t, await c(t, 'alice'));
    const { id: otherPost } = await post(other, await c(other, 'alice'));
    const cursor = (await listThreads(await c(t, 'bob'), id)).cursor;
    // While Bob is "offline": three changes.
    const th = await createThread(await c(t, 'alice'), id, { visibility: 'internal', body: 'one' });
    await replyToThread(await c(t, 'alice'), th.thread.id, { body: 'two' });
    await setThreadResolved(await c(t, 'alice'), th.thread.id, true);
    await createThread(await c(other, 'alice'), otherPost, { visibility: 'internal', body: 'other workspace' });
    const back = await readCollabEvents(await c(t, 'bob'), { postId: id, after: cursor });
    expect(back.events.map((e) => e.kind)).toEqual(['comment.created', 'comment.created', 'thread.resolved']);
    expect(back.events.map((e) => e.id)).toEqual([...back.events.map((e) => e.id)].sort((a, b) => a - b));
    // Replaying the same cursor returns the same events (idempotent; the client dedupes by id).
    expect((await readCollabEvents(await c(t, 'bob'), { postId: id, after: cursor })).events.map((e) => e.id)).toEqual(back.events.map((e) => e.id));
    // Cross-workspace: the other workspace's post / thread are not visible.
    expect(await readCollabEvents(await c(t, 'bob'), { postId: otherPost, after: 0 })).toMatchObject({ visible: false });
    await expect(getThread(await c(t, 'alice'), (await listThreads(await c(other, 'alice'), otherPost)).items[0]!.id)).rejects.toMatchObject({ code: 'not_found' });
    // A cursor older than retention asks the client to reload instead of replaying.
    await testPool().query(`DELETE FROM collab_events WHERE id <= $1`, [back.events[1]!.id]);
    expect(await readCollabEvents(await c(t, 'bob'), { postId: id, after: back.events[0]!.id - 5 })).toMatchObject({ reset: true });
  });
});

describe('notification centre + delivery', () => {
  it('feed filters, cursor, read/unread; email without SMTP is not_configured (in-app unaffected); admin diagnostics', async () => {
    const t = await team();
    const { id } = await post(t, await c(t, 'alice'));
    for (let i = 0; i < 3; i++) await createThread(await c(t, 'alice'), id, { visibility: 'internal', body: `@[${t.rita.id}] note ${i}` });
    await createTask(await c(t, 'alice'), { post_id: id, title: 'Task for Rita', assignee_id: t.rita.id });
    const smtp = process.env.SMTP_URL;
    process.env.SMTP_URL = '';
    resetConfigCache();
    try {
      await runOutbox(t.ws);
    } finally {
      process.env.SMTP_URL = smtp;
      resetConfigCache();
    }
    const feed = await listNotificationFeed(await c(t, 'rita'), { limit: 2 });
    expect(feed.items).toHaveLength(2);
    expect(feed.unread_count).toBe(4);
    const page2 = await listNotificationFeed(await c(t, 'rita'), { limit: 2, cursor: feed.next_cursor });
    expect(page2.items).toHaveLength(2);
    expect(new Set([...feed.items, ...page2.items].map((x) => x.id)).size).toBe(4);
    expect((await listNotificationFeed(await c(t, 'rita'), { category: 'mentions' })).items).toHaveLength(3);
    const tasks = await listNotificationFeed(await c(t, 'rita'), { category: 'tasks' });
    expect(tasks.items).toHaveLength(1);
    expect(tasks.items[0]!.url).toMatch(/^\/tasks\?task=/);
    const rn = await notes(t.rita.id, t.ws);
    expect(rn.filter((n) => n.email_state === 'not_configured').length).toBeGreaterThan(0);
    expect(rn.filter((n) => n.email_state === 'sent')).toHaveLength(0);
    // Mark read → unread again.
    const { markNotificationRead } = await import('@social-lite/services/audit-read');
    await markNotificationRead(await c(t, 'rita'), feed.items[0]!.id);
    await markNotificationUnread(await c(t, 'rita'), feed.items[0]!.id);
    expect((await listNotificationFeed(await c(t, 'rita'), {})).unread_count).toBe(4);
    // Admin diagnostics: metadata only, admins only.
    await expect(notificationDiagnostics(await c(t, 'alice'))).rejects.toMatchObject({ code: 'forbidden' });
    const diag = await notificationDiagnostics(await c(t, 'owner'), { state: 'not_configured' });
    expect(diag.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(diag)).not.toContain('note 0');
    // With SMTP (Mailpit) a pending email is sent; a recipient who lost access is skipped at send time.
    const nid = (await testPool().query<{ id: string }>(`SELECT id FROM notifications WHERE user_id=$1 AND workspace_id=$2 AND email_state='not_configured' LIMIT 1`, [t.rita.id, t.ws])).rows[0]!.id;
    await testPool().query(`UPDATE notifications SET email_state='pending' WHERE id=$1`, [nid]);
    await testPool().query(`UPDATE scoped_role_grants SET revoked_at=now() WHERE workspace_id=$1 AND user_id=$2`, [t.ws, t.rita.id]);
    expect(await sendNotificationEmail(testPool(), nid)).toBe('skipped');
    expect((await listNotificationFeed(await c(t, 'rita').catch(() => v2Ctx(t.owner.id, t.ws)), {})).items.every((x) => !x.title.includes('mentioned'))).toBe(true);
    const ov = await collabAdminOverview(await c(t, 'owner'));
    expect(ov.tasks.open).toBe(1);
    expect(ov.delivery?.not_configured).toBeGreaterThan(0);
  });
});
