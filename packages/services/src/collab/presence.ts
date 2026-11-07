// Presence on a post: who is viewing or editing right now. INFORMATIONAL ONLY — never used for authorization, locking or
// as proof that anything was saved. Not surveillance: no history is kept (rows are overwritten by heartbeats and purged
// 10 minutes after the last one), and a workspace can turn it off.
//   heartbeat every 20 s while the tab is visible → live for 60 s → "recently active" up to 5 min → gone.
// Only people who can currently read the post see it, and only active members who can still read it are listed
// (revoked members drop out immediately even if their row has not expired yet).
import { AppError, PRESENCE } from '@social-lite/core';
import { getPool, many, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { loadUserAuthz } from '../authz.js';
import { requireAction } from '../tenancy.js';
import { loadPost } from '../posts/service.js';
import { staffAllowed } from './access.js';
import { collabSettings } from './settings.js';

const CLIENT_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface PresencePerson { user_id: string; name: string; state: 'viewing' | 'editing' | 'recent'; last_seen_at: string; me: boolean }

async function listPresence(db: Queryable, ctx: Ctx, postId: string, brandId: string): Promise<PresencePerson[]> {
  const rows = await many<{ user_id: string; name: string | null; email: string; state: 'viewing' | 'editing'; last_seen_at: Date }>(db,
    `SELECT DISTINCT ON (pp.user_id) pp.user_id, u.name, u.email, pp.state, pp.last_seen_at
       FROM post_presence pp JOIN users u ON u.id=pp.user_id
       JOIN memberships m ON m.workspace_id=pp.workspace_id AND m.user_id=pp.user_id AND m.status='active' AND m.removed_at IS NULL
      WHERE pp.post_id=$1 AND pp.workspace_id=$2 AND pp.last_seen_at > now() - make_interval(secs => $3)
      ORDER BY pp.user_id, (pp.state = 'editing') DESC, pp.last_seen_at DESC LIMIT 20`, [postId, ctx.access.workspaceId, PRESENCE.recent]);
  const now = Date.now();
  const out: PresencePerson[] = [];
  for (const r of rows) {
    if (r.user_id !== ctx.actor.userId) {
      const s = await loadUserAuthz(r.user_id, ctx.access.workspaceId, null, db);
      if (s.subject.status !== 'active' || !staffAllowed(s, 'content.read', brandId)) continue;
    }
    const live = now - r.last_seen_at.getTime() <= PRESENCE.live * 1000;
    out.push({ user_id: r.user_id, name: r.name || r.email.split('@')[0]!, state: live ? r.state : 'recent', last_seen_at: r.last_seen_at.toISOString(), me: r.user_id === ctx.actor.userId });
  }
  return out.sort((a, b) => Number(a.me) - Number(b.me) || (a.state === 'recent' ? 1 : 0) - (b.state === 'recent' ? 1 : 0));
}

/** Heartbeat (or 'left' on tab close). Rate-bounded: a heartbeat within 5 s of the last one only reads. */
export async function presenceHeartbeat(ctx: Ctx, postId: string, input: { client_id: string; state: 'viewing' | 'editing' | 'left' }) {
  requireAction(ctx, 'content.read');
  if (typeof input.client_id !== 'string' || !CLIENT_RE.test(input.client_id)) throw new AppError('validation_failed', 'Invalid client id', { client_id: 'Invalid' });
  if (!['viewing', 'editing', 'left'].includes(input.state)) throw new AppError('validation_failed', 'Invalid state', { state: 'Invalid' });
  const db = getPool();
  const post = await loadPost(ctx, postId, db); // staff only (guests never appear in or see presence)
  const settings = await collabSettings(db, ctx.access.workspaceId);
  const ttl = { heartbeat_seconds: PRESENCE.heartbeat, live_seconds: PRESENCE.live, recent_seconds: PRESENCE.recent };
  if (!settings.presence_enabled) return { enabled: false, people: [] as PresencePerson[], ...ttl };
  if (input.state === 'left') {
    await db.query(`DELETE FROM post_presence WHERE post_id=$1 AND user_id=$2 AND client_id=$3`, [post.id, ctx.actor.userId, input.client_id]);
  } else {
    await db.query(
      `INSERT INTO post_presence(workspace_id, post_id, user_id, client_id, state) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (post_id, user_id, client_id) DO UPDATE SET state=$5, last_seen_at=now()
         WHERE post_presence.last_seen_at < now() - interval '5 seconds' OR post_presence.state <> $5`,
      [ctx.access.workspaceId, post.id, ctx.actor.userId, input.client_id, input.state]);
  }
  return { enabled: true, people: await listPresence(db, ctx, post.id, post.brand_id), ...ttl };
}

export async function getPresence(ctx: Ctx, postId: string) {
  requireAction(ctx, 'content.read');
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  const settings = await collabSettings(db, ctx.access.workspaceId);
  if (!settings.presence_enabled) return { enabled: false, people: [] };
  return { enabled: true, people: await listPresence(db, ctx, post.id, post.brand_id) };
}

/** Worker: drop expired rows (no presence history is kept) and rows of people who are no longer members. */
export async function purgePresence(db: Queryable = getPool()): Promise<number> {
  const r = await db.query(
    `DELETE FROM post_presence pp WHERE pp.last_seen_at < now() - make_interval(secs => $1)
        OR NOT EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id=pp.workspace_id AND m.user_id=pp.user_id AND m.status='active' AND m.removed_at IS NULL)`,
    [PRESENCE.purge]);
  return r.rowCount ?? 0;
}
