// Collaboration notifications (stream C): per-user preferences per event type (in-app / email / daily digest),
// quiet hours (critical security alerts bypass them), once per actionable event (dedupe key, insert-once),
// recipient entitlement re-checked at send, again when a delayed/batched email goes out, and at read time.
// Emails carry minimal content (a generic title + link); clicking a link only opens a page that re-checks access —
// it never approves or publishes anything.
import { BRAND } from '@social-lite/core';
import { AppError, isValidTimeZone, toLocalInput, type Permission } from '@social-lite/core';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { config } from '../config.js';
import { mailer, sendMail } from '../email.js';
import { emitCollabEvent } from './events.js';
import { log } from '../log.js';
import { assertUuid } from '../tenancy.js';
import { authorize } from '../authz.js';
import { entitledNow, staffAllowed, type Requirement } from './access.js';

export const NOTIFICATION_EVENTS = ['mention', 'comment', 'review_requested', 'review_decided', 'assignment', 'reminder', 'publishing_problem', 'account_health', 'budget', 'support'] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export interface Channels { in_app: boolean; email: boolean; digest: boolean }

export const DEFAULT_CHANNELS: Record<NotificationEvent, Channels> = {
  mention: { in_app: true, email: true, digest: false },
  comment: { in_app: true, email: false, digest: false },
  review_requested: { in_app: true, email: true, digest: false },
  review_decided: { in_app: true, email: false, digest: false },
  assignment: { in_app: true, email: true, digest: false },
  reminder: { in_app: true, email: false, digest: false },
  publishing_problem: { in_app: true, email: true, digest: false },
  account_health: { in_app: true, email: true, digest: false },
  budget: { in_app: true, email: true, digest: false },
  // V4 Relay support replies (support/notify.ts): emailed individually or not at all (never batched into a digest).
  support: { in_app: true, email: true, digest: false },
};

/** V1 notification kinds → preference event type. */
export function eventTypeForKind(kind: string): NotificationEvent {
  if (kind.startsWith('delivery.')) return 'publishing_problem';
  if (kind.startsWith('connection.')) return 'account_health';
  if (kind === 'budget') return 'budget';
  if (kind === 'approval.requested') return 'review_requested';
  if (kind.startsWith('approval.')) return 'review_decided';
  if (kind === 'mention') return 'mention';
  if (kind === 'assignment' || kind.startsWith('task.')) return kind.startsWith('task.reminder') ? 'reminder' : 'assignment';
  if (kind.startsWith('reminder')) return 'reminder';
  if (kind.startsWith('support.')) return 'support';
  return 'comment';
}

interface Settings { timezone: string; quiet_start: number | null; quiet_end: number | null; digest_hour: number; last_digest_at: Date | null }

export async function settingsFor(db: Queryable, workspaceId: string, userId: string): Promise<Settings> {
  const s = await maybeOne<Settings>(db, `SELECT timezone, quiet_start, quiet_end, digest_hour, last_digest_at FROM notification_settings WHERE workspace_id=$1 AND user_id=$2`, [workspaceId, userId]);
  return s ?? { timezone: 'UTC', quiet_start: null, quiet_end: null, digest_hour: 8, last_digest_at: null };
}

/** The member's own choice, else the workspace default (admin), else the product default. */
export async function channelsFor(db: Queryable, workspaceId: string, userId: string, ev: NotificationEvent): Promise<Channels> {
  const p = await maybeOne<Channels>(db, `SELECT in_app, email, digest FROM notification_preferences WHERE workspace_id=$1 AND user_id=$2 AND event_type=$3`, [workspaceId, userId, ev]);
  if (p) return p;
  return workspaceDefault(db, workspaceId, ev);
}

export async function workspaceDefault(db: Queryable, workspaceId: string, ev: NotificationEvent): Promise<Channels> {
  const w = await maybeOne<{ d: Partial<Channels> | null }>(db, `SELECT notification_defaults->$2 AS d FROM workspace_collab_settings WHERE workspace_id=$1`, [workspaceId, ev]);
  const base = DEFAULT_CHANNELS[ev];
  if (!w?.d) return base;
  return { in_app: w.d.in_app ?? base.in_app, email: w.d.email ?? base.email, digest: w.d.digest ?? base.digest };
}

function localMinutes(now: Date, tz: string): number {
  const [, hm] = toLocalInput(now, isValidTimeZone(tz) ? tz : 'UTC').split('T');
  const [h, m] = (hm ?? '00:00').split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** null when outside quiet hours; otherwise the instant quiet hours end. */
export function quietUntil(s: Pick<Settings, 'timezone' | 'quiet_start' | 'quiet_end'>, now = new Date()): Date | null {
  if (s.quiet_start === null || s.quiet_end === null || s.quiet_start === s.quiet_end) return null;
  const cur = localMinutes(now, s.timezone);
  const inQuiet = s.quiet_start < s.quiet_end ? cur >= s.quiet_start && cur < s.quiet_end : cur >= s.quiet_start || cur < s.quiet_end;
  if (!inQuiet) return null;
  const mins = (s.quiet_end - cur + 1440) % 1440;
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000 + mins * 60_000);
}

export interface CollabNotification {
  workspaceId: string; userId: string; event: NotificationEvent; severity?: 'info' | 'warning' | 'critical';
  kind: string; title: string; body?: string | null; referenceType: string; referenceId: string; dedupeKey: string;
  requirement: Requirement;
  /** Relative deep link (thread / task / review). Never carries content. */
  linkPath?: string | null; actorId?: string | null;
}

export type DeliverResult = 'created' | 'duplicate' | 'not_entitled' | 'muted';

/** Create one notification for one recipient if (and only if) they are entitled to the resource right now. */
export async function deliverNotification(db: Queryable, n: CollabNotification, now = new Date()): Promise<DeliverResult> {
  if (!(await entitledNow(db, n.workspaceId, n.userId, n.requirement))) return 'not_entitled';
  const ch = await channelsFor(db, n.workspaceId, n.userId, n.event);
  if (!ch.in_app && !ch.email && !ch.digest) return 'muted';
  const s = await settingsFor(db, n.workspaceId, n.userId);
  const quiet = quietUntil(s, now);
  const emailState = ch.email ? 'pending' : ch.digest ? 'digest' : 'none';
  const r = await maybeOne<{ id: string }>(db,
    `INSERT INTO notifications(workspace_id, user_id, severity, kind, title, body, reference_type, reference_id, dedupe_key,
                               event_type, brand_id, required_permission, in_app, email_state, email_after, link_path, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
    [n.workspaceId, n.userId, n.severity ?? 'info', n.kind, n.title.slice(0, 200), n.body?.slice(0, 500) ?? null, n.referenceType, n.referenceId, n.dedupeKey,
      n.event, n.requirement.brandId, n.requirement.permission === 'review.shared' ? `review.shared:${n.requirement.postId ?? ''}` : n.requirement.permission,
      ch.in_app, emailState, emailState === 'pending' ? (quiet ?? now) : null, safeLinkPath(n.linkPath), n.actorId ?? null]);
  if (!r) return 'duplicate';
  if (ch.in_app) await emitCollabEvent(db, { workspaceId: n.workspaceId, audience: 'user', userId: n.userId, kind: 'notification', refId: r.id });
  if (emailState === 'pending' && !quiet) await sendNotificationEmail(db, r.id);
  return 'created';
}

function parseRequirement(row: { brand_id: string | null; required_permission: string | null }): Requirement | null {
  if (!row.brand_id || !row.required_permission) return null;
  if (row.required_permission.startsWith('review.shared:')) return { brandId: row.brand_id, permission: 'review.shared', postId: row.required_permission.slice('review.shared:'.length) || null };
  return { brandId: row.brand_id, permission: row.required_permission as Permission };
}

/** Relative in-app path only ("/x/..."); anything else is dropped. */
export function safeLinkPath(p: string | null | undefined): string | null {
  if (!p || typeof p !== 'string' || p.length > 300 || !/^\/[A-Za-z0-9]/.test(p) || p.startsWith('//') || /[\s\\]/.test(p)) return null;
  return p;
}

function linkFor(row: { reference_type: string | null; reference_id: string | null; link_path?: string | null }): string {
  const base = config().APP_BASE_URL;
  if (row.link_path && safeLinkPath(row.link_path)) return `${base}${row.link_path}`;
  switch (row.reference_type) {
    case 'post': return `${base}/posts/${row.reference_id}`;
    case 'approval': return `${base}/approvals/${row.reference_id}`;
    case 'review': return `${base}/review/${row.reference_id}`;
    case 'connection': return `${base}/accounts`;
    default: return `${base}/`;
  }
}

const EMAIL_MAX_ATTEMPTS = 3;

/**
 * Send one pending email after re-checking entitlement (delayed sends included). Minimal content only: the generic
 * title + a link (never comment text, post text or task details). Without SMTP the row becomes 'not_configured' —
 * never 'sent'; in-app delivery is unaffected. A refused send is retried with backoff, then marked 'failed'.
 */
export async function sendNotificationEmail(db: Queryable, id: string): Promise<'sent' | 'skipped' | 'failed' | 'not_configured' | 'retry'> {
  const row = await maybeOne<{ id: string; workspace_id: string; user_id: string; title: string; reference_type: string | null; reference_id: string | null; link_path: string | null;
    brand_id: string | null; required_permission: string | null; email_state: string; email: string; critical_security: boolean; email_attempts: number; kind: string; scope: string }>(db,
    `SELECT n.id, n.workspace_id, n.user_id, n.title, n.reference_type, n.reference_id, n.link_path, n.brand_id, n.required_permission, n.email_state, u.email, n.critical_security, n.email_attempts,
            n.kind, n.scope
       FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.id=$1`, [id]);
  if (!row || row.email_state !== 'pending') return 'skipped';
  const req = parseRequirement(row);
  // V4: Relay support notifications (customer and platform-staff scope) re-check ticket visibility / staff role instead.
  const allowed = row.kind.startsWith('support.') || row.scope === 'platform'
    ? await (await import('../support/notify.js')).recipientStillAllowed(db, row)
    : !!(await maybeOne(db, `SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND removed_at IS NULL`, [row.workspace_id, row.user_id]))
      && !(req && !(await entitledNow(db, row.workspace_id, row.user_id, req)));
  if (!allowed) {
    await db.query(`UPDATE notifications SET email_state='skipped', email_error='recipient_not_entitled' WHERE id=$1`, [id]);
    return 'skipped';
  }
  if (!mailer()) {
    await db.query(`UPDATE notifications SET email_state='not_configured', email_error='smtp_not_configured' WHERE id=$1`, [id]);
    return 'not_configured';
  }
  const ok = await sendMail({ to: row.email, subject: `[${BRAND.name}] ${row.title}`, text: `${row.title}\n\nOpen: ${linkFor(row)}\n\nYou can change notification settings in ${BRAND.name}.\n` }).catch(() => false);
  if (ok) {
    await db.query(`UPDATE notifications SET email_state='sent', emailed_at=now(), email_attempts=email_attempts+1, email_error=NULL WHERE id=$1`, [id]);
    return 'sent';
  }
  const attempts = row.email_attempts + 1;
  if (attempts >= EMAIL_MAX_ATTEMPTS) {
    await db.query(`UPDATE notifications SET email_state='failed', email_attempts=$2, email_error='smtp_rejected' WHERE id=$1`, [id, attempts]);
    return 'failed';
  }
  await db.query(`UPDATE notifications SET email_attempts=$2, email_error='smtp_rejected', email_after=now() + make_interval(mins => $3) WHERE id=$1`, [id, attempts, 5 * attempts]);
  return 'retry';
}

/** Worker sweep: emails deferred by quiet hours whose time has come. */
export async function sendDueEmails(db: Queryable = getPool(), limit = 100): Promise<number> {
  const rows = await many<{ id: string }>(db, `SELECT id FROM notifications WHERE email_state='pending' AND email_after <= now() ORDER BY email_after LIMIT $1`, [limit]);
  let n = 0;
  for (const r of rows) if ((await sendNotificationEmail(db, r.id)) === 'sent') n++;
  return n;
}

/** Worker sweep: one daily digest per user (at their digest hour); every item re-checked before inclusion. */
export async function sendDigests(db: Queryable = getPool(), now = new Date()): Promise<number> {
  const users = await many<{ workspace_id: string; user_id: string }>(db,
    `SELECT DISTINCT workspace_id, user_id FROM notifications WHERE email_state='digest' LIMIT 500`);
  let sent = 0;
  for (const u of users) {
    const s = await settingsFor(db, u.workspace_id, u.user_id);
    if (localMinutes(now, s.timezone) < s.digest_hour * 60) continue;
    if (s.last_digest_at && now.getTime() - s.last_digest_at.getTime() < 20 * 3600_000) continue;
    const items = await many<{ id: string; title: string; brand_id: string | null; required_permission: string | null }>(db,
      `SELECT id, title, brand_id, required_permission FROM notifications WHERE workspace_id=$1 AND user_id=$2 AND email_state='digest' ORDER BY created_at LIMIT 200`,
      [u.workspace_id, u.user_id]);
    const keep: typeof items = [];
    for (const it of items) {
      const req = parseRequirement(it);
      if (!req || (await entitledNow(db, u.workspace_id, u.user_id, req))) keep.push(it);
      else await db.query(`UPDATE notifications SET email_state='skipped' WHERE id=$1`, [it.id]);
    }
    await db.query(
      `INSERT INTO notification_settings(workspace_id, user_id, last_digest_at) VALUES ($1,$2,$3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET last_digest_at=$3`, [u.workspace_id, u.user_id, now]);
    if (!keep.length) continue;
    if (!mailer()) {
      await db.query(`UPDATE notifications SET email_state='not_configured', email_error='smtp_not_configured' WHERE id = ANY($1::uuid[])`, [keep.map((k) => k.id)]);
      continue;
    }
    const to = await maybeOne<{ email: string }>(db, `SELECT email FROM users WHERE id=$1`, [u.user_id]);
    if (!to) continue;
    const ok = await sendMail({ to: to.email, subject: `[${BRAND.name}] Daily digest — ${keep.length} update${keep.length === 1 ? '' : 's'}`,
      text: `${keep.map((k) => `• ${k.title}`).join('\n')}\n\nOpen: ${config().APP_BASE_URL}/\n` }).catch(() => false);
    if (ok) {
      await db.query(`UPDATE notifications SET email_state='sent', emailed_at=now() WHERE id = ANY($1::uuid[])`, [keep.map((k) => k.id)]);
      sent++;
    }
  }
  return sent;
}

export async function runNotificationSweeps(db: Queryable = getPool()): Promise<void> {
  try {
    await sendDueEmails(db);
    await sendDigests(db);
  } catch (err) {
    log.warn('notification_sweep_failed', { err: err as Error });
  }
}

/**
 * Critical security alert (for identity/security flows): always in-app, emailed immediately — never muted,
 * never deferred by quiet hours, never batched into a digest.
 */
export async function notifySecurityAlert(db: Queryable, p: { workspaceId: string; userId: string; title: string; dedupeKey: string }): Promise<void> {
  const r = await maybeOne<{ id: string }>(db,
    `INSERT INTO notifications(workspace_id, user_id, severity, kind, title, reference_type, dedupe_key, event_type, in_app, email_state, email_after, critical_security)
     VALUES ($1,$2,'critical','security',$3,'security',$4,'account_health',true,'pending',now(),true)
     ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`, [p.workspaceId, p.userId, p.title.slice(0, 200), p.dedupeKey]);
  if (r) await sendNotificationEmail(db, r.id);
}

/**
 * V1 operational alerts (engine/notify.ts) route their email through preferences + quiet hours.
 * Called right after the V1 upsert; returns without sending when the preference/quiet hours say so.
 */
export async function routeOperationalEmail(db: Queryable, p: { notificationId: string; workspaceId: string; userId: string; kind: string; alreadyEmailed: boolean }): Promise<void> {
  const ev = eventTypeForKind(p.kind);
  const ch = await channelsFor(db, p.workspaceId, p.userId, ev);
  await db.query(`UPDATE notifications SET event_type=$2, in_app=$3 WHERE id=$1`, [p.notificationId, ev, ch.in_app]);
  if (p.alreadyEmailed) return;
  if (!ch.email && !ch.digest) return;
  const quiet = quietUntil(await settingsFor(db, p.workspaceId, p.userId));
  await db.query(`UPDATE notifications SET email_state=$2, email_after=$3 WHERE id=$1 AND email_state IN ('none','skipped')`,
    [p.notificationId, ch.email ? 'pending' : 'digest', ch.email ? (quiet ?? new Date()) : null]);
  if (ch.email && !quiet) await sendNotificationEmail(db, p.notificationId);
}

// ------------------------------------------------------------------ read side
interface ReadableRow { id: string; brand_id: string | null; required_permission: string | null }

/** Drop rows the caller is no longer entitled to (access may have changed since the notification was created). */
export async function filterReadable<T extends ReadableRow>(ctx: Ctx, rows: T[], db: Queryable = getPool()): Promise<T[]> {
  const shareIds = new Set<string>();
  const needShares = rows.map(parseRequirement).filter((r): r is Requirement => !!r && r.permission === 'review.shared' && !!r.postId).map((r) => r.postId!);
  if (needShares.length) {
    const shares = await many<{ post_id: string }>(db, `SELECT post_id FROM review_shares WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL AND post_id = ANY($3::uuid[])`,
      [ctx.access.workspaceId, ctx.actor.userId, needShares]);
    for (const s of shares) shareIds.add(s.post_id);
  }
  const state = ctx.access.authz;
  return rows.filter((row) => {
    const req = parseRequirement(row);
    if (!req) return true;
    if (!state) return ctx.access.brandIds === null || ctx.access.brandIds.includes(req.brandId);
    if (req.permission === 'review.shared') {
      return staffAllowed(state, 'content.read', req.brandId) || (!!req.postId && shareIds.has(req.postId) && authorize(state, 'content.read', { brandId: req.brandId }).allowed);
    }
    return staffAllowed(state, req.permission, req.brandId);
  });
}

/** Deep link from the bell/email: re-check access on open, mark read, return where to go. Never acts on the resource. */
export async function openNotification(ctx: Ctx, id: string, db: Queryable = getPool()): Promise<{ href: string }> {
  assertUuid(id, 'Notification');
  const row = await maybeOne<ReadableRow & { reference_type: string | null; reference_id: string | null; link_path: string | null }>(db,
    `SELECT id, brand_id, required_permission, reference_type, reference_id, link_path FROM notifications WHERE id=$1 AND workspace_id=$2 AND user_id=$3`,
    [id, ctx.access.workspaceId, ctx.actor.userId]);
  if (!row || !(await filterReadable(ctx, [row], db)).length) throw new AppError('not_found', 'This item is no longer available to you');
  await db.query(`UPDATE notifications SET read_at=coalesce(read_at, now()) WHERE id=$1`, [id]);
  return { href: linkFor(row).slice(config().APP_BASE_URL.length) || '/' };
}

// ------------------------------------------------------------------ preferences API
export async function getNotificationPreferences(ctx: Ctx, db: Queryable = getPool()) {
  const rows = await many<Channels & { event_type: NotificationEvent }>(db,
    `SELECT event_type, in_app, email, digest FROM notification_preferences WHERE workspace_id=$1 AND user_id=$2`, [ctx.access.workspaceId, ctx.actor.userId]);
  const s = await settingsFor(db, ctx.access.workspaceId, ctx.actor.userId);
  return {
    events: NOTIFICATION_EVENTS.map((e) => ({ event_type: e, ...(rows.find((r) => r.event_type === e) ?? DEFAULT_CHANNELS[e]) })),
    timezone: s.timezone, quiet_start: s.quiet_start, quiet_end: s.quiet_end, digest_hour: s.digest_hour,
  };
}

export async function updateNotificationPreferences(ctx: Ctx, input: {
  events?: Array<{ event_type: string } & Partial<Channels>>; timezone?: string; quiet_start?: number | null; quiet_end?: number | null; digest_hour?: number;
}, db: Queryable = getPool()) {
  for (const e of input.events ?? []) {
    if (!(NOTIFICATION_EVENTS as readonly string[]).includes(e.event_type)) throw new AppError('validation_failed', 'Unknown notification type', { events: 'Unknown type' });
    const d = DEFAULT_CHANNELS[e.event_type as NotificationEvent];
    await db.query(
      `INSERT INTO notification_preferences(workspace_id, user_id, event_type, in_app, email, digest) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (workspace_id, user_id, event_type) DO UPDATE SET in_app=$4, email=$5, digest=$6, updated_at=now()`,
      [ctx.access.workspaceId, ctx.actor.userId, e.event_type, e.in_app ?? d.in_app, e.email ?? d.email, (e.digest ?? d.digest) && !(e.email ?? d.email)]);
  }
  if (input.timezone !== undefined || input.quiet_start !== undefined || input.quiet_end !== undefined || input.digest_hour !== undefined) {
    const cur = await settingsFor(db, ctx.access.workspaceId, ctx.actor.userId);
    const tz = input.timezone ?? cur.timezone;
    if (!isValidTimeZone(tz)) throw new AppError('validation_failed', 'Unknown time zone', { timezone: 'Use an IANA time zone' });
    const qs = input.quiet_start === undefined ? cur.quiet_start : input.quiet_start;
    const qe = input.quiet_end === undefined ? cur.quiet_end : input.quiet_end;
    const okMin = (v: number | null) => v === null || (Number.isInteger(v) && v >= 0 && v < 1440);
    if (!okMin(qs) || !okMin(qe) || (qs === null) !== (qe === null)) throw new AppError('validation_failed', 'Quiet hours need a start and an end', { quiet_start: 'Set both or neither' });
    const dh = input.digest_hour ?? cur.digest_hour;
    if (!Number.isInteger(dh) || dh < 0 || dh > 23) throw new AppError('validation_failed', 'Digest hour must be 0-23', { digest_hour: '0-23' });
    await db.query(
      `INSERT INTO notification_settings(workspace_id, user_id, timezone, quiet_start, quiet_end, digest_hour) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET timezone=$3, quiet_start=$4, quiet_end=$5, digest_hour=$6, updated_at=now()`,
      [ctx.access.workspaceId, ctx.actor.userId, tz, qs, qe, dh]);
  }
  return getNotificationPreferences(ctx, db);
}
