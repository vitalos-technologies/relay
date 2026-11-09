// V3.1 Admin — PLATFORM scope (brief §4). Relay operators of this installation, named in `platform_operators`
// (migration 026) and re-read from the database on every request (revocation is effective on the next request).
//  - 'support'  : read-only platform views + support-access requests.
//  - 'operator' : everything 'support' can do + lifecycle, rollouts, dispatch, operators. Changes need a fresh,
//                 MFA-verified session (step-up through the identity provider), are audited in platform_audit_events
//                 (append-only for app roles) and, when they affect a workspace, also in that workspace's audit.
// Operators see aggregates and metadata only: counts, states, provider names, error codes. Never post text, media,
// documents, credentials or tokens. Private content needs support access (support-access.ts).
import { z } from 'zod';
import { AppError, notFound, PROVIDERS, type Provider } from '@social-lite/core';
import { FEATURE_FLAGS } from '@social-lite/core/contracts/v31-gov';
import type {
  PlatformAuditItem, PlatformFlag, PlatformOperatorDto, PlatformOverview, PlatformRole, PlatformWorkspaceDetail, PlatformWorkspaceItem,
} from '@social-lite/core/contracts/v31-admin';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Actor } from '../context.js';
import { audit } from '../audit.js';
import { redact } from '../log.js';
import { assertUuid } from '../tenancy.js';
import { DEFAULT_STEP_UP_SECONDS } from '../security.js';
import { listSupportAccessFor } from './support-access.js';
import { onScopePaused, onScopeResumed } from '../engine/hooks.js';
import { pgbossReadable } from '../workload/stats.js';

export interface PlatformCtx {
  actor: Actor;
  role: PlatformRole;
  assurance: { mfaVerified: boolean; authTime: Date | null };
  correlationId: string;
}

export async function loadOperatorRole(userId: string, db: Queryable = getPool()): Promise<PlatformRole | null> {
  const r = await maybeOne<{ role: PlatformRole }>(db,
    `SELECT o.role FROM platform_operators o JOIN users u ON u.id=o.user_id WHERE o.user_id=$1 AND o.revoked_at IS NULL AND u.disabled_at IS NULL`, [userId]);
  return r?.role ?? null;
}

/**
 * 'operator' ⊇ 'support' and 'operator' ⊇ 'billing' (V4). 'staff' = any platform role (metadata-only views).
 * 'support' excludes billing staff (support access reaches customer content); 'billing' excludes support staff (billing
 * powers). Throws forbidden (never reveals whether something exists).
 */
export function requirePlatform(p: PlatformCtx, need: PlatformRole | 'staff'): void {
  if (need === 'staff') return;
  if (p.role === 'operator' || p.role === need) return;
  throw new AppError('forbidden', need === 'operator' ? 'Platform operators only' : need === 'billing' ? 'Billing staff only' : 'Support staff only');
}

/** Sensitive platform changes need a fresh, MFA-verified sign-in (identity provider step-up). */
export function requireFresh(p: PlatformCtx): void {
  const fresh = p.assurance.mfaVerified && !!p.assurance.authTime && Date.now() - p.assurance.authTime.getTime() <= DEFAULT_STEP_UP_SECONDS * 1000;
  if (!fresh) throw new AppError('step_up_required', 'Confirm it’s you to continue.');
}

export function isFresh(p: PlatformCtx): boolean {
  return p.assurance.mfaVerified && !!p.assurance.authTime && Date.now() - p.assurance.authTime.getTime() <= DEFAULT_STEP_UP_SECONDS * 1000;
}

export async function platformAudit(db: Queryable, p: PlatformCtx | null, e: {
  action: string; targetType: string; targetId?: string | null; workspaceId?: string | null; reason?: string | null;
  outcome?: 'success' | 'denied' | 'failed'; diff?: Record<string, unknown>; actorService?: string | null; correlationId?: string | null;
}): Promise<void> {
  await db.query(
    `INSERT INTO platform_audit_events(actor_user_id, actor_service, action, target_type, target_id, workspace_id, reason, outcome, diff, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [p?.actor.userId ?? null, p ? null : (e.actorService ?? 'system'), e.action, e.targetType, e.targetId ?? null, e.workspaceId ?? null,
      e.reason ?? null, e.outcome ?? 'success', JSON.stringify(redact(e.diff ?? {})), e.correlationId ?? p?.correlationId ?? null]);
}

const reasonSchema = z.string().trim().min(10, 'Give a reason (10+ characters)').max(500);

// ------------------------------------------------------------------ overview
export async function platformOverview(p: PlatformCtx, db: Queryable = getPool()): Promise<PlatformOverview> {
  requirePlatform(p, 'staff');
  const ws = await one<{ active: number; suspended: number; demo: number }>(db,
    `SELECT count(*) FILTER (WHERE state='active')::int active, count(*) FILTER (WHERE state='suspended')::int suspended, count(*) FILTER (WHERE is_demo)::int demo FROM workspaces`);
  const users = await one<{ total: number; disabled: number; signed_in_24h: number }>(db,
    `SELECT count(*)::int total, count(*) FILTER (WHERE disabled_at IS NOT NULL)::int disabled, count(*) FILTER (WHERE last_login_at > now() - interval '24 hours')::int signed_in_24h FROM users`);
  const workers = await many<{ worker_id: string; version: string | null; last_seen_at: Date; info: Record<string, unknown> | null }>(db,
    `SELECT worker_id, version, last_seen_at, info FROM worker_heartbeats WHERE last_seen_at > now() - interval '1 day' ORDER BY last_seen_at DESC LIMIT 20`);
  const due = await one<{ n: number; oldest: Date | null }>(db,
    `SELECT count(*)::int n, min(next_attempt_at) oldest FROM deliveries WHERE state IN ('scheduled','retry_wait') AND next_attempt_at <= now() AND lease_owner IS NULL`);
  const queues: PlatformOverview['queues'] = [{ queue: 'deliveries (due)', waiting: due.n, oldest_age_seconds: due.oldest ? Math.max(0, Math.round((Date.now() - due.oldest.getTime()) / 1000)) : 0 }];
  const jobsVisible = await pgbossReadable(db);
  if (jobsVisible) {
    const jobs = await many<{ name: string; n: number; age: number | null }>(db,
      `SELECT name, count(*)::int n, extract(epoch FROM now() - min(start_after))::float8 age FROM pgboss.job
        WHERE state IN ('created','retry') AND start_after <= now() GROUP BY name ORDER BY name`);
    for (const j of jobs) queues.push({ queue: j.name, waiting: j.n, oldest_age_seconds: Math.max(0, Math.round(j.age ?? 0)) });
  }
  const outbox = await one<{ pending: number; dead: number; oldest: Date | null }>(db,
    `SELECT count(*) FILTER (WHERE dispatch_state='pending' AND available_at <= now())::int pending, count(*) FILTER (WHERE dispatch_state='dead')::int dead,
            min(available_at) FILTER (WHERE dispatch_state='pending' AND available_at <= now()) oldest FROM outbox WHERE dispatch_state IN ('pending','dead')`);
  const circuits = await many<{ provider: string; state: string; failure_count: number; opened_until: Date | null }>(db,
    `SELECT provider::text, state, failure_count, opened_until FROM provider_circuits ORDER BY provider`);
  // Per workspace through (workspace_id, updated_at): one index range per workspace, no whole-table scan.
  const states = await many<{ state: string; is_mock: boolean; n: number }>(db,
    `SELECT d.state::text, d.is_mock, count(*)::int n FROM workspaces w
       CROSS JOIN LATERAL (SELECT state, is_mock FROM deliveries x WHERE x.workspace_id=w.id AND x.updated_at > now() - interval '24 hours') d
      GROUP BY d.state, d.is_mock`);
  const conns = await many<{ provider: Provider; total: number; problems: number; simulated: number }>(db,
    `SELECT provider, count(*)::int total,
            count(*) FILTER (WHERE NOT is_mock AND (status NOT IN ('ready','expiring') OR paused))::int problems,
            count(*) FILTER (WHERE is_mock OR is_synthetic)::int simulated
       FROM connections WHERE disconnected_at IS NULL GROUP BY provider ORDER BY provider`);
  const sync = await one<{ failed: number; ok: number }>(db,
    `SELECT count(*) FILTER (WHERE status='failed')::int failed, count(*) FILTER (WHERE status='succeeded')::int ok FROM sync_runs WHERE started_at > now() - interval '24 hours'`)
    .catch(() => ({ failed: 0, ok: 0 }));
  const stale = await one<{ n: number }>(db,
    `SELECT count(*)::int n FROM connections c WHERE c.disconnected_at IS NULL AND NOT c.is_mock AND NOT c.is_synthetic
        AND NOT EXISTS (SELECT 1 FROM sync_runs r WHERE r.connection_id=c.id AND r.status='succeeded' AND r.started_at > now() - interval '48 hours')`).catch(() => ({ n: 0 }));
  const support = await one<{ requested: number; active: number }>(db,
    `SELECT count(*) FILTER (WHERE status='requested' AND request_expires_at > now())::int requested,
            count(*) FILTER (WHERE status='active' AND expires_at > now())::int active FROM support_access_grants WHERE status IN ('requested','active')`);
  const flags = await one<{ killed: number; rolling: number }>(db,
    `SELECT count(*) FILTER (WHERE killed)::int killed, count(*) FILTER (WHERE NOT killed AND rollout_percent > 0 AND rollout_percent < 100)::int rolling FROM feature_flags`);
  const dispatch = await maybeOne<{ value: unknown }>(db, `SELECT value FROM system_flags WHERE key='dispatch_enabled'`);
  const dispatchEnabled = dispatch?.value !== false;
  const live = Object.fromEntries(states.filter((s) => !s.is_mock).map((s) => [s.state, s.n]));
  const simulated = Object.fromEntries(states.filter((s) => s.is_mock).map((s) => [s.state, s.n]));
  const age = (d: Date) => Math.round((Date.now() - d.getTime()) / 1000);
  const alerts: PlatformOverview['alerts'] = [];
  if (!dispatchEnabled) alerts.push({ severity: 'critical', message: 'Dispatch is off for the whole installation.' });
  if (!workers.some((w) => age(w.last_seen_at) < 60)) alerts.push({ severity: 'critical', message: 'No worker heartbeat in the last 60 seconds.' });
  if (queues[0]!.oldest_age_seconds > 120) alerts.push({ severity: 'warning', message: 'Due publications have waited more than 2 minutes.' });
  if (outbox.dead > 0) alerts.push({ severity: 'warning', message: `${outbox.dead} outbox events are dead-lettered.` });
  if ((live.unknown ?? 0) > 0) alerts.push({ severity: 'warning', message: `${live.unknown} live results are Unknown (last 24 h).` });
  for (const c of circuits) if (c.state === 'open') alerts.push({ severity: 'warning', message: `Provider circuit open: ${c.provider}.` });
  return {
    generated_at: new Date().toISOString(), dispatch_enabled: dispatchEnabled, workspaces: ws, users,
    workers: workers.map((w) => ({ worker_id: w.worker_id, version: w.version, age_seconds: age(w.last_seen_at), stopped: !!w.info?.stopped })),
    queues, jobs_visible: jobsVisible, outbox: { pending: outbox.pending, dead: outbox.dead, oldest_age_seconds: outbox.oldest ? Math.max(0, age(outbox.oldest)) : 0 },
    circuits: circuits.map((c) => ({ ...c, opened_until: c.opened_until?.toISOString() ?? null })),
    deliveries_24h: { live, simulated }, connections: conns,
    analytics: { failed_runs_24h: sync.failed, succeeded_runs_24h: sync.ok, stale_connections: stale.n },
    support, flags: { killed: flags.killed, rolling_out: flags.rolling }, alerts,
  };
}

// ------------------------------------------------------------------ workspaces (metadata only)
const listQuery = z.object({
  q: z.string().trim().max(80).optional().nullable(),
  state: z.enum(['active', 'suspended']).optional().nullable(),
  demo: z.enum(['true', 'false']).optional().nullable(),
  cursor: z.string().max(300).optional().nullable(),
  limit: z.coerce.number().int().min(1).max(100).optional().nullable(),
});

const WS_COLUMNS = `w.id, w.name, w.state, w.is_demo, w.created_at, w.publishing_paused,
  (SELECT count(*)::int FROM memberships m WHERE m.workspace_id=w.id AND m.status='active') members,
  (SELECT count(*)::int FROM brands b WHERE b.workspace_id=w.id AND b.archived_at IS NULL) brands,
  (SELECT count(*)::int FROM connections c WHERE c.workspace_id=w.id AND c.disconnected_at IS NULL) connections,
  (SELECT count(*)::int FROM deliveries d WHERE d.workspace_id=w.id AND d.state IN ('scheduled','retry_wait') AND d.due_at > now()) scheduled,
  (SELECT count(*)::int FROM deliveries d WHERE d.workspace_id=w.id AND d.state IN ('failed','unknown','expired') AND d.updated_at > now() - interval '7 days') failed_7d,
  (SELECT a.created_at FROM audit_events a WHERE a.workspace_id=w.id ORDER BY a.created_at DESC, a.id DESC LIMIT 1) last_activity_at`;

type WsRow = Omit<PlatformWorkspaceItem, 'created_at' | 'last_activity_at'> & { created_at: Date; last_activity_at: Date | null };
const wsJson = (r: WsRow): PlatformWorkspaceItem => ({ ...r, created_at: r.created_at.toISOString(), last_activity_at: r.last_activity_at?.toISOString() ?? null });

export async function listPlatformWorkspaces(p: PlatformCtx, raw: unknown, db: Queryable = getPool()): Promise<{ items: PlatformWorkspaceItem[]; next_cursor: string | null; total: number }> {
  requirePlatform(p, 'staff');
  const q = listQuery.parse(raw ?? {});
  const limit = q.limit ?? 25;
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.q) { params.push(`%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); where.push(`w.name ILIKE $${params.length}`); }
  if (q.state) { params.push(q.state); where.push(`w.state = $${params.length}`); }
  if (q.demo) { params.push(q.demo === 'true'); where.push(`w.is_demo = $${params.length}`); }
  const total = await one<{ n: number }>(db, `SELECT count(*)::int n FROM workspaces w ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, params);
  if (q.cursor) {
    const [name, id] = Buffer.from(q.cursor, 'base64url').toString().split('\u0000');
    if (!name || !id) throw new AppError('validation_failed', 'Invalid cursor');
    params.push(name, id); where.push(`(lower(w.name), w.id) > ($${params.length - 1}, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const rows = await many<WsRow & { lname: string }>(db,
    `SELECT ${WS_COLUMNS}, lower(w.name) lname FROM workspaces w ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY lower(w.name), w.id LIMIT $${params.length}`, params);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(({ lname: _l, ...r }) => wsJson(r)), total: total.n,
    next_cursor: rows.length > limit && last ? Buffer.from(`${last.lname}\u0000${last.id}`).toString('base64url') : null,
  };
}

export async function platformWorkspace(p: PlatformCtx, workspaceId: string, db: Queryable = getPool()): Promise<PlatformWorkspaceDetail> {
  requirePlatform(p, 'staff');
  assertUuid(workspaceId, 'Workspace');
  const w = await maybeOne<WsRow & { suspended_at: Date | null; suspended_reason: string | null; paused_reason: string | null; limits: Record<string, unknown> }>(db,
    `SELECT ${WS_COLUMNS}, w.suspended_at, w.suspended_reason, w.paused_reason, w.limits FROM workspaces w WHERE w.id=$1`, [workspaceId]);
  if (!w) throw notFound('Workspace');
  const owners = await many<{ id: string; email: string; name: string | null }>(db,
    `SELECT u.id, u.email::text, u.name FROM scoped_role_grants g JOIN users u ON u.id=g.user_id JOIN memberships m ON m.workspace_id=g.workspace_id AND m.user_id=g.user_id
      WHERE g.workspace_id=$1 AND g.role='owner' AND g.revoked_at IS NULL AND m.status='active' ORDER BY u.email`, [workspaceId]);
  const statuses = await many<{ status: string; n: number }>(db, `SELECT status, count(*)::int n FROM memberships WHERE workspace_id=$1 GROUP BY status`, [workspaceId]);
  const conns = await many<{ provider: Provider; status: string; n: number; simulated: number }>(db,
    `SELECT provider, status::text, count(*)::int n, count(*) FILTER (WHERE is_mock OR is_synthetic)::int simulated FROM connections
      WHERE workspace_id=$1 AND disconnected_at IS NULL GROUP BY provider, status ORDER BY provider, status`, [workspaceId]);
  const del = await many<{ state: string; n: number }>(db,
    `SELECT state::text, count(*)::int n FROM deliveries WHERE workspace_id=$1 AND updated_at > now() - interval '7 days' AND NOT is_mock GROUP BY state`, [workspaceId]);
  const flags = await many<{ key: string; enabled: boolean }>(db, `SELECT key, enabled FROM workspace_feature_flags WHERE workspace_id=$1 ORDER BY key`, [workspaceId]);
  const audit = await platformAuditList(p, { workspace_id: workspaceId, limit: 20 }, db);
  const dc = w.limits?.dispatch_concurrency;
  const { limits: _l, suspended_at, ...rest } = w;
  return {
    ...wsJson(rest as WsRow), suspended_at: suspended_at?.toISOString() ?? null, suspended_reason: w.suspended_reason, paused_reason: w.paused_reason,
    owners, member_status: Object.fromEntries(statuses.map((s) => [s.status, s.n])), connections_by_provider: conns,
    deliveries_7d: Object.fromEntries(del.map((d) => [d.state, d.n])),
    dispatch_concurrency: typeof dc === 'number' ? dc : null, flag_overrides: flags,
    support_access: await listSupportAccessFor(db, { workspaceId }), audit: audit.items,
    // V4: count only (metadata); lazy import keeps admin/platform free of a static dependency on support/*.
    open_support_requests: await (await import('../support/staff.js')).openTicketCount(workspaceId, db),
  };
}

const suspendSchema = z.object({ reason: reasonSchema }).strict();

/** Platform suspension: members lose access on their next request (loadAccess); dispatch holds (engine gate). */
export async function suspendWorkspace(p: PlatformCtx, workspaceId: string, raw: unknown) {
  requirePlatform(p, 'operator');
  requireFresh(p);
  assertUuid(workspaceId, 'Workspace');
  const { reason } = suspendSchema.parse(raw);
  return withTx((tx) => suspendWorkspaceTx(tx, workspaceId, { p, reason }));
}

/**
 * The suspension itself (inside a transaction). `p` = the acting operator; null = a staff-SCHEDULED suspension executed by
 * the billing sweep (V4 billing_scheduled_actions), recorded with `actorService` and the scheduling operator in the diff.
 */
export async function suspendWorkspaceTx(tx: Queryable, workspaceId: string, by: { p: PlatformCtx | null; reason: string; actorService?: string; scheduledBy?: string | null }) {
  const w = await maybeOne<{ state: string; name: string }>(tx, `SELECT state, name FROM workspaces WHERE id=$1 FOR UPDATE`, [workspaceId]);
  if (!w) throw notFound('Workspace');
  if (w.state === 'suspended') throw new AppError('invalid_state', 'This workspace is already suspended.');
  const affected = await one<{ scheduled: number; in_flight: number }>(tx,
    `SELECT count(*) FILTER (WHERE state IN ('scheduled','retry_wait'))::int scheduled, count(*) FILTER (WHERE state IN ('preparing','publishing','processing'))::int in_flight
       FROM deliveries WHERE workspace_id=$1`, [workspaceId]);
  const actorId = by.p?.actor.userId ?? by.scheduledBy ?? null;
  await tx.query(`UPDATE workspaces SET state='suspended', suspended_at=now(), suspended_by=$2, suspended_reason=$3, policy_version=policy_version+1 WHERE id=$1`,
    [workspaceId, actorId, by.reason]);
  // Waiting deliveries move to Paused now; in-flight ones finish (the gate holds any that are claimed later).
  const paused = await onScopePaused(tx, { workspaceId });
  Object.assign(affected, { paused });
  const extra = by.p ? {} : { scheduled_by: by.scheduledBy ?? null };
  await platformAudit(tx, by.p, { action: 'workspace.suspended', targetType: 'workspace', targetId: workspaceId, workspaceId, reason: by.reason,
    actorService: by.actorService ?? null, diff: { name: w.name, ...affected, ...extra } });
  await audit(tx, { workspaceId, actorUserId: by.p ? by.p.actor.userId : null, actorService: by.p ? null : (by.actorService ?? 'system'), action: 'platform.workspace_suspended',
    resourceType: 'workspace', resourceId: workspaceId, diff: { reason: by.reason, ...affected, ...extra }, correlationId: by.p?.correlationId ?? null });
  return { ok: true as const, affected };
}

export async function reactivateWorkspace(p: PlatformCtx, workspaceId: string, raw: unknown) {
  requirePlatform(p, 'operator');
  requireFresh(p);
  assertUuid(workspaceId, 'Workspace');
  const { reason } = suspendSchema.parse(raw);
  return withTx(async (tx) => {
    const w = await maybeOne<{ state: string }>(tx, `SELECT state FROM workspaces WHERE id=$1 FOR UPDATE`, [workspaceId]);
    if (!w) throw notFound('Workspace');
    if (w.state !== 'suspended') throw new AppError('invalid_state', 'This workspace is not suspended.');
    await tx.query(`UPDATE workspaces SET state='active', suspended_at=NULL, suspended_by=NULL, suspended_reason=NULL, policy_version=policy_version+1 WHERE id=$1`, [workspaceId]);
    // Resumes only what no workspace/brand/connection pause still holds; past-deadline items expire (normal rules).
    const affected = await onScopeResumed(tx, { workspaceId });
    await platformAudit(tx, p, { action: 'workspace.reactivated', targetType: 'workspace', targetId: workspaceId, workspaceId, reason, diff: affected });
    await audit(tx, { workspaceId, actorUserId: p.actor.userId, action: 'platform.workspace_reactivated', resourceType: 'workspace', resourceId: workspaceId, diff: { reason, ...affected }, correlationId: p.correlationId });
    return { ok: true as const, affected };
  });
}

const concurrencySchema = z.object({ dispatch_concurrency: z.number().int().min(1).max(32).nullable(), reason: reasonSchema }).strict();

/** Operator-only: per-workspace live-lease cap (engine/fairness.ts). Tenants can't raise their own share. */
export async function setDispatchConcurrency(p: PlatformCtx, workspaceId: string, raw: unknown) {
  requirePlatform(p, 'operator');
  requireFresh(p);
  assertUuid(workspaceId, 'Workspace');
  const input = concurrencySchema.parse(raw);
  return withTx(async (tx) => {
    const w = await maybeOne<{ limits: Record<string, unknown> }>(tx, `SELECT limits FROM workspaces WHERE id=$1 FOR UPDATE`, [workspaceId]);
    if (!w) throw notFound('Workspace');
    const next = { ...(w.limits ?? {}) };
    const before = next.dispatch_concurrency ?? null;
    if (input.dispatch_concurrency === null) delete next.dispatch_concurrency; else next.dispatch_concurrency = input.dispatch_concurrency;
    await tx.query(`UPDATE workspaces SET limits=$2 WHERE id=$1`, [workspaceId, JSON.stringify(next)]);
    await platformAudit(tx, p, { action: 'workspace.dispatch_concurrency_set', targetType: 'workspace', targetId: workspaceId, workspaceId, reason: input.reason,
      diff: { before, after: input.dispatch_concurrency } });
    await audit(tx, { workspaceId, actorUserId: p.actor.userId, action: 'platform.dispatch_concurrency_set', resourceType: 'workspace', resourceId: workspaceId,
      diff: { before, after: input.dispatch_concurrency }, correlationId: p.correlationId });
    return { dispatch_concurrency: input.dispatch_concurrency };
  });
}

const dispatchSchema = z.object({ enabled: z.boolean(), reason: reasonSchema }).strict();

/** Installation-wide dispatch switch (system_flags.dispatch_enabled; enforced at claim time). */
export async function setGlobalDispatch(p: PlatformCtx, raw: unknown) {
  requirePlatform(p, 'operator');
  requireFresh(p);
  const input = dispatchSchema.parse(raw);
  return withTx(async (tx) => {
    const before = await maybeOne<{ value: unknown }>(tx, `SELECT value FROM system_flags WHERE key='dispatch_enabled' FOR UPDATE`);
    await tx.query(`INSERT INTO system_flags(key, value, updated_by) VALUES ('dispatch_enabled', $1::jsonb, $2)
                    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`,
      [JSON.stringify(input.enabled), `operator:${p.actor.userId}`]);
    await platformAudit(tx, p, { action: input.enabled ? 'dispatch.enabled' : 'dispatch.disabled', targetType: 'installation', reason: input.reason,
      diff: { before: before?.value !== false, after: input.enabled } });
    return { dispatch_enabled: input.enabled };
  });
}

// ------------------------------------------------------------------ feature flag rollouts (installation rows)
export async function listPlatformFlags(p: PlatformCtx, db: Queryable = getPool()): Promise<{ items: PlatformFlag[] }> {
  requirePlatform(p, 'staff');
  const rows = await many<{ key: string; description: string; default_enabled: boolean; rollout_percent: number; killed: boolean; updated_at: Date | null; updated_by: string | null; overrides: number }>(db,
    `SELECT f.*, (SELECT count(*)::int FROM workspace_feature_flags o WHERE o.key=f.key) overrides FROM feature_flags f ORDER BY f.key`);
  const keys = [...new Set([...FEATURE_FLAGS.map((f) => f.key), ...rows.map((r) => r.key)])].sort();
  return {
    items: keys.map((key) => {
      const r = rows.find((x) => x.key === key);
      const def = FEATURE_FLAGS.find((f) => f.key === key);
      return {
        key, description: r?.description || def?.description || '', default_enabled: r?.default_enabled ?? !!def?.default_enabled,
        rollout_percent: r?.rollout_percent ?? 0, killed: r?.killed ?? false, overrides: r?.overrides ?? 0,
        updated_at: r?.updated_at?.toISOString() ?? null, updated_by: r?.updated_by ?? null, registered: !!def,
      };
    }),
  };
}

const flagPatch = z.object({
  rollout_percent: z.number().int().min(0).max(100).optional(),
  killed: z.boolean().optional(),
  default_enabled: z.boolean().optional(),
  reason: reasonSchema,
}).strict();

export async function updatePlatformFlag(p: PlatformCtx, key: string, raw: unknown) {
  requirePlatform(p, 'operator');
  requireFresh(p);
  if (!FEATURE_FLAGS.some((f) => f.key === key)) throw notFound('Flag');
  const patch = flagPatch.parse(raw);
  await withTx(async (tx) => {
    const def = FEATURE_FLAGS.find((f) => f.key === key)!;
    await tx.query(`INSERT INTO feature_flags(key, description, default_enabled) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING`, [key, def.description, def.default_enabled]);
    const before = await one<{ rollout_percent: number; killed: boolean; default_enabled: boolean }>(tx, `SELECT rollout_percent, killed, default_enabled FROM feature_flags WHERE key=$1 FOR UPDATE`, [key]);
    const after = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => k !== 'reason' && v !== undefined)) } as typeof before;
    await tx.query(`UPDATE feature_flags SET rollout_percent=$2, killed=$3, default_enabled=$4, updated_at=now(), updated_by=$5 WHERE key=$1`,
      [key, after.rollout_percent, after.killed, after.default_enabled, `operator:${p.actor.userId}`]);
    await platformAudit(tx, p, { action: 'feature_flag.updated', targetType: 'feature_flag', targetId: key, reason: patch.reason, diff: { before, after } });
  });
  return listPlatformFlags(p);
}

// ------------------------------------------------------------------ platform audit
const auditQuery = z.object({
  workspace_id: z.string().uuid().optional().nullable(),
  action: z.string().trim().max(80).optional().nullable(),
  cursor: z.string().max(40).optional().nullable(),
  limit: z.coerce.number().int().min(1).max(100).optional().nullable(),
});

export async function platformAuditList(p: PlatformCtx, raw: unknown, db: Queryable = getPool()): Promise<{ items: PlatformAuditItem[]; next_cursor: string | null }> {
  requirePlatform(p, 'staff');
  const q = auditQuery.parse(raw ?? {});
  const limit = q.limit ?? 50;
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.workspace_id) { params.push(q.workspace_id); where.push(`e.workspace_id = $${params.length}`); }
  if (q.action) { params.push(`${q.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); where.push(`e.action LIKE $${params.length}`); }
  if (q.cursor) { if (!/^\d+$/.test(q.cursor)) throw new AppError('validation_failed', 'Invalid cursor'); params.push(q.cursor); where.push(`e.id < $${params.length}::bigint`); }
  params.push(limit + 1);
  const rows = await many<{ id: string; created_at: Date; actor: string | null; action: string; target_type: string; target_id: string | null; workspace_id: string | null;
    workspace_name: string | null; reason: string | null; outcome: string; diff: Record<string, unknown>; correlation_id: string | null }>(db,
    `SELECT e.id::text, e.created_at, coalesce(u.email::text, e.actor_service) actor, e.action, e.target_type, e.target_id, e.workspace_id, w.name workspace_name,
            e.reason, e.outcome, e.diff, e.correlation_id
       FROM platform_audit_events e LEFT JOIN users u ON u.id=e.actor_user_id LEFT JOIN workspaces w ON w.id=e.workspace_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.id DESC LIMIT $${params.length}`, params);
  const page = rows.slice(0, limit);
  return {
    items: page.map(({ created_at, ...r }) => ({ ...r, at: created_at.toISOString() })),
    next_cursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}

// ------------------------------------------------------------------ operators
export async function listOperators(p: PlatformCtx, db: Queryable = getPool()): Promise<{ items: PlatformOperatorDto[] }> {
  requirePlatform(p, 'staff');
  const rows = await many<{ user_id: string; email: string; name: string | null; role: PlatformRole; granted_at: Date; granted_via: string; revoked_at: Date | null; note: string | null }>(db,
    `SELECT o.user_id, u.email::text, u.name, o.role, o.granted_at, o.granted_via, o.revoked_at, o.note FROM platform_operators o JOIN users u ON u.id=o.user_id
      ORDER BY o.revoked_at NULLS FIRST, u.email`);
  return { items: rows.map((r) => ({ ...r, granted_at: r.granted_at.toISOString(), revoked_at: r.revoked_at?.toISOString() ?? null })) };
}

const grantOperatorSchema = z.object({ email: z.string().trim().email().max(254), role: z.enum(['operator', 'support', 'billing']), reason: reasonSchema }).strict();

/** Operators may name other operators/support staff (existing Relay users only). Self-changes are refused. */
export async function grantOperator(p: PlatformCtx, raw: unknown) {
  requirePlatform(p, 'operator');
  requireFresh(p);
  const input = grantOperatorSchema.parse(raw);
  return withTx(async (tx) => {
    const u = await maybeOne<{ id: string }>(tx, `SELECT id FROM users WHERE email=$1 AND disabled_at IS NULL`, [input.email]);
    if (!u) throw new AppError('validation_failed', 'No active user has that email. They need to sign in once first.', { email: 'They must sign in once first' });
    if (u.id === p.actor.userId) throw new AppError('forbidden', 'You cannot change your own platform role');
    await tx.query(`INSERT INTO platform_operators(user_id, role, granted_by, granted_via, note) VALUES ($1,$2,$3,'admin',$4)
                    ON CONFLICT (user_id) DO UPDATE SET role=EXCLUDED.role, granted_by=EXCLUDED.granted_by, granted_via='admin', granted_at=now(),
                      revoked_at=NULL, revoked_by=NULL, note=EXCLUDED.note`, [u.id, input.role, p.actor.userId, input.reason.slice(0, 200)]);
    await platformAudit(tx, p, { action: 'operator.granted', targetType: 'user', targetId: u.id, reason: input.reason, diff: { email: input.email, role: input.role } });
    return { ok: true as const };
  });
}

export async function revokeOperator(p: PlatformCtx, userId: string, raw: unknown) {
  requirePlatform(p, 'operator');
  requireFresh(p);
  assertUuid(userId, 'Operator');
  const { reason } = suspendSchema.parse(raw);
  if (userId === p.actor.userId) throw new AppError('forbidden', 'You cannot change your own platform role');
  return withTx(async (tx) => {
    const r = await tx.query(`UPDATE platform_operators SET revoked_at=now(), revoked_by=$2 WHERE user_id=$1 AND revoked_at IS NULL`, [userId, p.actor.userId]);
    if (!r.rowCount) throw notFound('Operator');
    // Their open support access ends with the role.
    const ended = await tx.query<{ id: string }>(`SELECT id FROM support_access_grants WHERE operator_user_id=$1 AND status IN ('requested','active')`, [userId]);
    const { endSupportAccessTx } = await import('./support-access.js');
    for (const g of ended.rows) await endSupportAccessTx(tx, g.id, { userId: p.actor.userId, reason: 'operator_role_revoked', correlationId: p.correlationId });
    await platformAudit(tx, p, { action: 'operator.revoked', targetType: 'user', targetId: userId, reason, diff: { support_access_ended: ended.rowCount ?? 0 } });
    return { ok: true as const };
  });
}

// ------------------------------------------------------------------ accounts (platform scope ≠ workspace membership)
const accountQuery = z.object({ q: z.string().trim().min(3).max(120) });

/** Find accounts by email/name (min 3 chars). Returns identity + membership counts only. */
export async function findAccounts(p: PlatformCtx, raw: unknown, db: Queryable = getPool()) {
  requirePlatform(p, 'staff');
  const { q } = accountQuery.parse(raw ?? {});
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await many<{ id: string; email: string; name: string | null; disabled_at: Date | null; last_login_at: Date | null; workspaces: number; operator: string | null }>(db,
    `SELECT u.id, u.email::text, u.name, u.disabled_at, u.last_login_at,
            (SELECT count(*)::int FROM memberships m WHERE m.user_id=u.id AND m.status='active') workspaces,
            (SELECT o.role FROM platform_operators o WHERE o.user_id=u.id AND o.revoked_at IS NULL) operator
       FROM users u WHERE u.email ILIKE $1 OR u.name ILIKE $1 ORDER BY u.email LIMIT 20`, [like]);
  return { items: rows.map((r) => ({ ...r, disabled_at: r.disabled_at?.toISOString() ?? null, last_login_at: r.last_login_at?.toISOString() ?? null })) };
}

/**
 * Platform account suspension: sign-in and every session end now (users.disabled_at is checked by resolveSession and
 * API keys are unaffected — they belong to service accounts). Workspace memberships are NOT removed: each workspace
 * keeps its own record, and publications the person scheduled keep their recorded authority until a workspace
 * admin suspends/removes the membership (then the V2 hold/adopt rules apply).
 */
export async function setAccountDisabled(p: PlatformCtx, userId: string, raw: unknown, disabled: boolean) {
  requirePlatform(p, 'operator');
  requireFresh(p);
  assertUuid(userId, 'Account');
  const { reason } = suspendSchema.parse(raw);
  if (userId === p.actor.userId) throw new AppError('forbidden', 'You cannot suspend your own account');
  return withTx(async (tx) => {
    const u = await maybeOne<{ disabled_at: Date | null; email: string }>(tx, `SELECT disabled_at, email::text FROM users WHERE id=$1 FOR UPDATE`, [userId]);
    if (!u) throw notFound('Account');
    if (disabled === !!u.disabled_at) throw new AppError('invalid_state', disabled ? 'This account is already suspended.' : 'This account is not suspended.');
    await tx.query(`UPDATE users SET disabled_at=$2 WHERE id=$1`, [userId, disabled ? new Date() : null]);
    let sessions = 0;
    if (disabled) {
      const r = await tx.query(`UPDATE sessions SET revoked_at=now(), revoked_reason='account_suspended' WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
      sessions = r.rowCount ?? 0;
    }
    const scheduled = await one<{ n: number }>(tx,
      `SELECT count(*)::int n FROM publication_authorizations a JOIN schedules s ON s.id=a.schedule_id WHERE a.principal_user_id=$1 AND s.status='active'`, [userId]);
    await platformAudit(tx, p, { action: disabled ? 'account.suspended' : 'account.reactivated', targetType: 'user', targetId: userId, reason,
      diff: { email: u.email, sessions_revoked: sessions, active_schedules_authorized: scheduled.n } });
    return { ok: true as const, sessions_revoked: sessions, active_schedules_authorized: scheduled.n };
  });
}

export const PLATFORM_PROVIDERS: readonly Provider[] = PROVIDERS;

// ------------------------------------------------------------------ integration infrastructure (provider apps, not accounts)
export interface PlatformIntegration {
  key: string; label: string; kind: 'social' | 'content' | 'mcp' | 'email' | 'ai';
  /** configured = app credentials present; it does NOT mean customers' accounts work (that is per connection). */
  status: 'configured' | 'not_configured' | 'no_app_needed' | 'not_available';
  missing: string[]; live_accounts: number | null; simulated_accounts: number | null; note: string | null;
}

export async function platformIntegrations(p: PlatformCtx, db: Queryable = getPool()): Promise<{ items: PlatformIntegration[] }> {
  requirePlatform(p, 'staff');
  const { listProviderStatus } = await import('../connections/manage.js');
  const { googleContentConfig, notionConfig } = await import('../content-hub/config.js');
  const { mcpConfig } = await import('../mcp/config.js');
  const { getSetting } = await import('../settings.js');
  const { config } = await import('../config.js');
  const { aiModelSetupState } = await import('../ai/models.js');
  const providers = (await listProviderStatus({} as never)).items;
  const counts = await many<{ provider: string; live: number; sim: number }>(db,
    `SELECT provider::text, count(*) FILTER (WHERE NOT is_mock AND NOT is_synthetic)::int live, count(*) FILTER (WHERE is_mock OR is_synthetic)::int sim
       FROM connections WHERE disconnected_at IS NULL GROUP BY provider`);
  const content = await many<{ source: string; n: number }>(db, `SELECT source, count(*)::int n FROM content_connections WHERE disconnected_at IS NULL GROUP BY source`).catch(() => []);
  const items: PlatformIntegration[] = providers.map((s) => {
    const c = counts.find((x) => x.provider === s.provider);
    const noApp = s.provider === 'telegram' || s.provider === 'bluesky';
    return { key: s.provider, label: s.provider, kind: 'social' as const, status: noApp ? 'no_app_needed' as const : s.configured ? 'configured' as const : 'not_configured' as const,
      missing: s.missing, live_accounts: c?.live ?? 0, simulated_accounts: c?.sim ?? 0, note: noApp ? 'Each customer brings their own credentials' : null };
  });
  const g = await googleContentConfig();
  const n = await notionConfig();
  items.push({ key: 'google', label: 'Google Drive and Docs', kind: 'content', status: g.clientId && g.clientSecret ? 'configured' : 'not_configured',
    missing: [!g.clientId && 'GOOGLE_CONTENT_CLIENT_ID', !g.clientSecret && 'GOOGLE_CONTENT_CLIENT_SECRET', !g.pickerApiKey && 'GOOGLE_PICKER_API_KEY'].filter(Boolean) as string[],
    live_accounts: content.find((x) => x.source === 'google')?.n ?? 0, simulated_accounts: null, note: g.sharedClient ? 'Reuses the YouTube OAuth client' : null });
  items.push({ key: 'notion', label: 'Notion', kind: 'content', status: n.clientId && n.clientSecret ? 'configured' : 'not_configured',
    missing: [!n.clientId && 'NOTION_CLIENT_ID', !n.clientSecret && 'NOTION_CLIENT_SECRET'].filter(Boolean) as string[],
    live_accounts: content.find((x) => x.source === 'notion')?.n ?? 0, simulated_accounts: null, note: null });
  const m = mcpConfig();
  items.push({ key: 'mcp', label: 'MCP endpoint', kind: 'mcp', status: m.issuer && m.resourceUrl.startsWith('https://') ? 'configured' : 'not_configured',
    missing: [!m.issuer && 'MCP authorization server', !m.resourceUrl.startsWith('https://') && 'public HTTPS URL'].filter(Boolean) as string[], live_accounts: null, simulated_accounts: null,
    note: 'Real MCP clients need public HTTPS' });
  const smtp = process.env.SMTP_URL ?? '';
  items.push({ key: 'email', label: 'Email (SMTP)', kind: 'email', status: smtp && !/localhost:1025|127\.0\.0\.1:1025/.test(smtp) ? 'configured' : 'not_configured',
    missing: smtp ? (/:1025/.test(smtp) ? ['production SMTP (local capture in use)'] : []) : ['SMTP_URL'], live_accounts: null, simulated_accounts: null, note: null });
  // D32: AI needs the provider key AND AI_MODEL; prices are optional (unknown cost otherwise). Names only, never values.
  const ai = await getSetting('ANTHROPIC_API_KEY').catch(() => undefined);
  const aiModel = aiModelSetupState();
  const aiNotes = [config().APP_ENV === 'production' ? null : 'Development installation', aiModel.model && !aiModel.price ? 'No model price set: cost estimates unknown' : null].filter(Boolean);
  items.push({ key: 'ai', label: 'AI assistance', kind: 'ai', status: ai && aiModel.model ? 'configured' : 'not_configured',
    missing: [!ai && 'ANTHROPIC_API_KEY', !aiModel.model && 'AI_MODEL'].filter(Boolean) as string[], live_accounts: null, simulated_accounts: null,
    note: aiNotes.length ? aiNotes.join(' · ') : null });
  return { items };
}
