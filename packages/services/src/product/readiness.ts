// Publishing readiness preflight (V2 §7): one read-only check run before Schedule / Publish now /
// Submit, returning every reason with its fix: permission (V2 policy, per destination), tokens and
// scopes, media and content validation, approval policy, deadline, provider limits (rate limits,
// throttles, Instagram content_publishing_limit), budgets, pauses and duplicate/collision warnings.
// The schedule APIs still enforce their own rules; this is the explanation layer the UI gates on.
import { z } from 'zod';
import {
  AppError, PROVIDER_LABEL, resolveVariants, type DeliveryState, type DenyReason, type Permission, type Provider,
} from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { assertBrand, authorizeCtx, requireAction } from '../tenancy.js';
import { audit } from '../audit.js';
import { loadPost, validateDraft } from '../posts/service.js';
import { resolveScheduleTime } from '../posts/scheduling.js';
import { brandConnections } from '../posts/shared.js';
import { classifyConnection, type ConnectionFacts } from './health.js';
import { findDuplicates, type DuplicateMatch } from './duplicates.js';
import { wouldFit } from './budgets.js';

export const readinessRequestSchema = z.object({
  mode: z.enum(['schedule', 'publish', 'submit']).default('schedule'),
  connection_ids: z.array(z.string().uuid()).max(50),
  input_local_time: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/).nullish(),
  timezone: z.string().min(1).max(64).nullish(),
  offset: z.string().regex(/^[+-]\d{2}:\d{2}$/).nullish(),
  deadline_minutes: z.number().int().min(1).max(10_080).nullish(),
});
export type ReadinessRequest = z.infer<typeof readinessRequestSchema>;

export type CheckKey = 'permission' | 'tokens' | 'media' | 'content' | 'approval' | 'deadline' | 'provider_limits' | 'budget' | 'paused' | 'duplicates';
export interface ReadinessCheck {
  key: CheckKey; status: 'pass' | 'warn' | 'fail' | 'info'; title: string; message: string;
  connection_id: string | null; fix: string | null;
}

/** Known, documented provider limits (docs/providers/*). Facebook publishes none: not claimed. */
export const PROVIDER_LIMITS: Partial<Record<Provider, { windowMs: number; max: number; label: string; source: string }>> = {
  instagram: { windowMs: 24 * 3600_000, max: 50, label: '50 API posts per rolling 24 h', source: 'content_publishing_limit (quota_total 50)' },
  x: { windowMs: 15 * 60_000, max: 100, label: '100 posts per 15 min per user', source: 'X API POST /2/tweets rate limit' },
  telegram: { windowMs: 60_000, max: 20, label: '20 messages per minute per channel', source: 'Telegram Bot FAQ flood limits' },
};

const DENY_TEXT: Record<DenyReason, string> = {
  not_member: 'You are no longer a member of this workspace.',
  suspended: 'Your membership is suspended.',
  disabled: 'This identity is disabled.',
  restricted: 'An explicit restriction blocks this for you on this brand.',
  no_grant: 'You do not have this permission on this brand or destination.',
  mfa_required: 'Verify with your second factor (MFA) first.',
  step_up_required: 'Confirm it’s you (recent sign-in) first.',
  workspace_scope_required: 'This needs a workspace-level role.',
};

const ACTIVE: DeliveryState[] = ['scheduled', 'retry_wait', 'preparing', 'publishing', 'processing', 'published', 'blocked', 'paused', 'unknown'];

export async function readiness(ctx: Ctx, postId: string, raw: unknown, db: Queryable = getPool()) {
  const req = readinessRequestSchema.parse(raw ?? {});
  const post = await loadPost(ctx, postId, db);
  const r = authorizeCtx(ctx, 'content.read', { brandId: post.brand_id });
  if (!r.allowed) throw new AppError('not_found', 'Post not found');
  const brand = await assertBrand(ctx, post.brand_id, db);
  const checks: ReadinessCheck[] = [];
  const add = (c: Omit<ReadinessCheck, 'connection_id' | 'fix'> & { connection_id?: string | null; fix?: string | null }) =>
    checks.push({ connection_id: null, fix: null, ...c });
  const ids = [...new Set(req.connection_ids)];
  const all = await brandConnections(db, ctx.access.workspaceId, post.brand_id, true);
  const conns = ids.map((id) => all.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c);
  const name = (id: string) => all.find((c) => c.id === id)?.display_name ?? 'Destination';

  // ---- permission (V2 policy, per destination: connection-scoped grants are honoured)
  const perms: Permission[] = req.mode === 'submit' ? ['content.submit'] : req.mode === 'publish' ? ['content.schedule', 'content.publish'] : ['content.schedule'];
  const verb = req.mode === 'submit' ? 'submit for review' : req.mode === 'publish' ? 'publish' : 'schedule';
  let permOk = true;
  for (const perm of perms) {
    const targets = ids.length ? ids : [null];
    for (const cid of targets) {
      const d = authorizeCtx(ctx, perm, { brandId: post.brand_id, connectionId: cid });
      if (!d.allowed) {
        permOk = false;
        add({ key: 'permission', status: 'fail', title: `Can’t ${verb}`, message: DENY_TEXT[d.reason as DenyReason] ?? DENY_TEXT.no_grant, connection_id: cid,
          fix: d.reason === 'mfa_required' ? 'Sign in again with your second factor.' : d.reason === 'step_up_required' ? 'Re-authenticate, then try again.' : 'Ask an owner or admin for the publisher role on this brand.' });
      }
    }
  }
  if (permOk) add({ key: 'permission', status: 'pass', title: 'Permission', message: `You may ${verb} on ${brand.name}.` });

  // ---- destinations: tokens / scopes / health
  if (!ids.length) add({ key: 'tokens', status: 'fail', title: 'No destination', message: 'Choose at least one destination.' });
  for (const id of ids.filter((x) => !all.some((c) => c.id === x))) {
    add({ key: 'tokens', status: 'fail', title: 'Unknown destination', message: 'This destination is not connected to this brand.', connection_id: id, fix: 'Deselect it.' });
  }
  const facts = conns.length ? await many<ConnectionFacts>(db,
    `SELECT c.id, c.brand_id, c.provider, c.display_name, c.status, c.is_mock, c.paused, c.disconnected_at, c.throttled_until, c.health_detail, c.health_checked_at,
            cr.expires_at AS cred_expires_at, cr.refresh_expires_at, cr.granted_scopes, CASE WHEN pc.state='open' THEN pc.opened_until END AS circuit_open_until
       FROM connections c LEFT JOIN credentials cr ON cr.id=c.credential_id AND cr.workspace_id=c.workspace_id LEFT JOIN provider_circuits pc ON pc.provider=c.provider
      WHERE c.workspace_id=$1 AND c.id = ANY($2::uuid[])`, [ctx.access.workspaceId, conns.map((c) => c.id)]) : [];

  // ---- deadline (resolved exactly as the schedule API will)
  let dueAt: Date | null = null;
  let publishBefore: Date | null = null;
  try {
    const mode = req.mode === 'publish' || (req.mode === 'submit' && !req.input_local_time) ? (req.mode === 'submit' ? 'on_approval' : 'immediate') : 'timed';
    const t = resolveScheduleTime({ input_local_time: req.input_local_time ?? undefined, timezone: req.timezone ?? undefined, offset: req.offset ?? undefined, deadline_minutes: req.deadline_minutes ?? undefined }, brand, mode);
    dueAt = t.dueAt; publishBefore = t.publishBefore;
    const graceMin = Math.round((t.publishBefore.getTime() - t.dueAt.getTime()) / 60_000);
    add({ key: 'deadline', status: 'pass', title: 'Time', message: mode === 'timed' ? `Due ${t.localTime.replace('T', ' ')} ${t.timezone}; expires if not sent within ${graceMin} min.` : mode === 'on_approval' ? 'Publishes when approved.' : `Sends now; expires if not sent within ${graceMin} min.` });
  } catch (e) {
    const err = e as AppError;
    add({ key: 'deadline', status: 'fail', title: 'Time', message: err.message, fix: err.details && (err.details as { reason?: string }).reason === 'ambiguous_time' ? 'Pick which of the two clock times you mean.' : 'Choose a valid future time.' });
  }
  const at = dueAt ?? new Date();

  for (const f of facts) {
    const issues = classifyConnection(f, { canManage: authorizeCtx(ctx, 'connections.manage', { brandId: f.brand_id, connectionId: f.id }).allowed });
    const blocking = issues.filter((i) => i.severity === 'critical' || (i.code === 'expiring' && i.at_risk_from && new Date(i.at_risk_from).getTime() <= at.getTime()));
    for (const i of blocking) {
      add({ key: 'tokens', status: 'fail', title: `${f.display_name}: ${i.title}`, message: i.detail, connection_id: f.id, fix: i.fix.allowed ? i.fix.how : `${i.fix.who}: ${i.fix.how}` });
    }
    for (const i of issues.filter((x) => !blocking.includes(x) && (x.code === 'expiring' || x.code === 'pending_verification'))) {
      add({ key: 'tokens', status: i.code === 'pending_verification' ? 'fail' : 'warn', title: `${f.display_name}: ${i.title}`, message: i.detail, connection_id: f.id, fix: i.fix.how });
    }
    if (f.paused) add({ key: 'paused', status: 'warn', title: `${f.display_name}: paused`, message: 'Held until this destination is resumed.', connection_id: f.id, fix: 'Accounts → Resume.' });
    if (f.throttled_until && f.throttled_until.getTime() > at.getTime()) {
      add({ key: 'provider_limits', status: 'warn', title: `${f.display_name}: rate limited`, message: `${PROVIDER_LABEL[f.provider]} asked to wait until ${f.throttled_until.toISOString().slice(11, 16)} UTC; this will send after that.`, connection_id: f.id });
    }
    if (!f.is_mock && f.circuit_open_until && f.circuit_open_until.getTime() > at.getTime()) {
      add({ key: 'provider_limits', status: 'warn', title: `${PROVIDER_LABEL[f.provider]} errors`, message: 'Sending is paused briefly after repeated provider errors; it will retry.', connection_id: f.id });
    }
  }
  if (ids.length && !checks.some((c) => c.key === 'tokens' && c.status === 'fail')) add({ key: 'tokens', status: 'pass', title: 'Accounts', message: 'Every destination is connected with the permissions it needs.' });

  // ---- pauses (workspace / brand)
  const ws = await maybeOne<{ publishing_paused: boolean }>(db, `SELECT publishing_paused FROM workspaces WHERE id=$1`, [ctx.access.workspaceId]);
  if (ws?.publishing_paused) add({ key: 'paused', status: 'warn', title: 'Workspace paused', message: 'Emergency pause is on: posts are held until it is lifted.' });
  if (brand.publishing_paused) add({ key: 'paused', status: 'warn', title: 'Brand paused', message: `Publishing for ${brand.name} is paused: posts are held until resumed.` });

  // ---- media + content (the same validation the schedule API runs)
  if (ids.length) {
    const v = await validateDraft(db, ctx, post, ids.filter((id) => all.some((c) => c.id === id)));
    const mediaIssues = v.issues.filter((i) => i.field === 'media' || /media|image|video|aspect|asset/i.test(i.code));
    const contentIssues = v.issues.filter((i) => !mediaIssues.includes(i) && i.field !== 'destination');
    for (const i of mediaIssues) add({ key: 'media', status: 'fail', title: i.connectionId ? `${name(i.connectionId)}: media` : 'Media', message: i.message, connection_id: i.connectionId ?? null });
    for (const i of contentIssues) add({ key: 'content', status: 'fail', title: i.connectionId ? `${name(i.connectionId)}: content` : 'Content', message: i.message, connection_id: i.connectionId ?? null });
    const assetIds = [...new Set([...post.draft.baseAssetIds, ...post.draft.variants.filter((x) => ids.includes(x.connectionId)).flatMap((x) => x.assetIds ?? [])])];
    const notReady = assetIds.length ? await many<{ id: string; status: string; original_filename: string | null }>(db,
      `SELECT id, status, original_filename FROM assets WHERE workspace_id=$1 AND id = ANY($2::uuid[]) AND status NOT IN ('ready')`, [ctx.access.workspaceId, assetIds]) : [];
    for (const a of notReady) {
      if (mediaIssues.some((i) => i.message.includes(a.original_filename ?? '\u0000'))) continue;
      add({ key: 'media', status: 'fail', title: 'Media not ready', message: `${a.original_filename ?? 'A file'} is ${a.status === 'rejected' ? 'rejected' : a.status === 'archived' ? 'archived' : 'still processing'}.`,
        fix: a.status === 'rejected' ? 'Replace it.' : 'Wait for processing to finish.' });
    }
    if (!checks.some((c) => c.key === 'media')) add({ key: 'media', status: 'pass', title: 'Media', message: assetIds.length ? 'All media is processed and fits every destination.' : 'No media attached.' });
    if (!checks.some((c) => c.key === 'content')) add({ key: 'content', status: 'pass', title: 'Content', message: 'Text and links fit every destination.' });
  }

  // ---- approval policy state
  const policy = await approvalPolicyState(db, ctx.access.workspaceId, post.brand_id, brand.approval_required);
  const pending = await maybeOne<{ id: string }>(db, `SELECT a.id FROM approvals a JOIN schedules s ON s.id=a.schedule_id WHERE s.post_id=$1 AND s.status='pending_approval' AND a.decision='pending' LIMIT 1`, [post.id]);
  if (policy.stages > 0) {
    const desc = `${policy.stages} review stage${policy.stages > 1 ? 's' : ''}${policy.separationOfDuties ? ', authors cannot approve their own work' : ''}`;
    if (req.mode === 'submit') add({ key: 'approval', status: 'pass', title: 'Review', message: `Goes to review: ${desc}.` });
    else add({ key: 'approval', status: 'fail', title: 'Approval required', message: `${brand.name} requires ${desc}.`, fix: 'Submit for review instead.' });
    if (pending) add({ key: 'approval', status: 'info', title: 'Already in review', message: 'A review request is pending; submitting again replaces it.' });
  } else if (req.mode === 'submit') {
    add({ key: 'approval', status: 'fail', title: 'No review needed', message: `${brand.name} does not require approval.`, fix: 'Schedule it directly.' });
  } else {
    add({ key: 'approval', status: 'pass', title: 'Approval', message: 'No approval required for this brand.' });
  }

  // ---- provider limits (documented per-account limits vs. work already queued in the window)
  for (const c of conns.filter((x) => !x.disconnected_at)) {
    const lim = PROVIDER_LIMITS[c.provider];
    if (!lim) continue;
    const n = await maybeOne<{ n: number }>(db,
      `SELECT count(*)::int n FROM deliveries WHERE connection_id=$1 AND post_id <> $2 AND state = ANY($3::delivery_state[])
          AND coalesce(published_at, due_at) > $4 AND coalesce(published_at, due_at) <= $5`,
      [c.id, post.id, ACTIVE, new Date(at.getTime() - lim.windowMs), new Date(at.getTime() + lim.windowMs)]);
    const used = (n?.n ?? 0) + 1;
    if (used > lim.max) add({ key: 'provider_limits', status: 'fail', title: `${c.display_name}: limit`, message: `${used} posts around this time exceeds ${PROVIDER_LABEL[c.provider]}’s ${lim.label}.`, connection_id: c.id, fix: 'Spread these posts out or pick another time.' });
    else if (used >= Math.ceil(lim.max * 0.8)) add({ key: 'provider_limits', status: 'warn', title: `${c.display_name}: near limit`, message: `${used} of ${lim.max} (${lim.label}).`, connection_id: c.id });
  }
  if (!checks.some((c) => c.key === 'provider_limits')) add({ key: 'provider_limits', status: 'pass', title: 'Provider limits', message: 'Within known provider limits.' });

  // ---- budgets (live X posts are billable; workspace + your teams)
  const liveX = conns.filter((c) => c.provider === 'x' && !c.is_mock && !c.disconnected_at).length;
  if (liveX) {
    const fit = await wouldFit(ctx.access.workspaceId, 'x.write', liveX, ctx.actor.userId, db);
    if (!fit.ok) add({ key: 'budget', status: 'fail', title: 'X budget', message: `${fit.detail?.scope === 'team' ? `Team “${fit.detail.team_name}”` : 'Workspace'} X post budget is used up (${fit.detail?.used} of ${fit.detail?.cap}).`, fix: 'Ask the owner to raise it in Settings → Budgets.' });
    else if (fit.usage.cap !== null && fit.usage.used + fit.usage.reserved + liveX >= fit.usage.cap * 0.8) add({ key: 'budget', status: 'warn', title: 'X budget', message: `${fit.usage.used + liveX} of ${fit.usage.cap} X posts this month after this.` });
    else add({ key: 'budget', status: 'pass', title: 'Budget', message: 'Within the X post budget.' });
  } else {
    add({ key: 'budget', status: 'pass', title: 'Budget', message: 'No billable destinations selected.' });
  }

  // ---- duplicate / collision warning (advisory; never a hard failure)
  const window = await maybeOne<{ duplicate_window_hours: number }>(db, `SELECT duplicate_window_hours FROM brands WHERE id=$1`, [post.brand_id]);
  const windowHours = window?.duplicate_window_hours ?? 24;
  let duplicates: DuplicateMatch[] = [];
  if (windowHours > 0 && conns.length) {
    const draft = { ...post.draft, variants: ids.map((id) => post.draft.variants.find((v) => v.connectionId === id) ?? { connectionId: id, inheritText: true, inheritMedia: true }) };
    const resolved = resolveVariants(draft, all);
    duplicates = await findDuplicates(db, { workspaceId: ctx.access.workspaceId, postId: post.id, at, windowHours,
      targets: resolved.map((v) => ({ connectionId: v.connectionId, text: v.text, assetIds: v.assetIds })) });
    for (const d of duplicates) {
      add({ key: 'duplicates', status: 'warn', title: `${name(d.connection_id)}: similar post`,
        message: `${d.reason === 'same_media' ? 'Same media as' : `${Math.round(d.similarity * 100)}% similar to`} “${d.other_title ?? d.other_excerpt}” (${d.other_state.replace('_', ' ')}, ${d.other_at.slice(0, 16).replace('T', ' ')} UTC).`,
        connection_id: d.connection_id, fix: 'Edit it, pick another time, or confirm it is intentional.' });
    }
  }
  if (!duplicates.length) add({ key: 'duplicates', status: 'pass', title: 'No duplicates', message: windowHours ? `Nothing similar to these destinations within ${windowHours} h.` : 'Duplicate check is off for this brand.' });

  const fails = checks.filter((c) => c.status === 'fail');
  return {
    ready: fails.length === 0, mode: req.mode,
    needs_acknowledgement: duplicates.length > 0,
    summary: { fail: fails.length, warn: checks.filter((c) => c.status === 'warn').length },
    resolved: dueAt ? { due_at: dueAt.toISOString(), publish_before: publishBefore?.toISOString() ?? null } : null,
    duplicate_window_hours: windowHours,
    checks, duplicates,
    generated_at: new Date().toISOString(),
  };
}

async function approvalPolicyState(db: Queryable, workspaceId: string, brandId: string, legacyRequired: boolean): Promise<{ stages: number; separationOfDuties: boolean }> {
  const has = await maybeOne<{ t: string | null }>(db, `SELECT to_regclass('approval_policies')::text AS t`);
  if (!has?.t) return { stages: legacyRequired ? 1 : 0, separationOfDuties: false };
  const p = await maybeOne<{ stage_count: number; separation_of_duties: boolean }>(db,
    `SELECT v.stage_count, v.separation_of_duties FROM approval_policies p JOIN approval_policy_versions v ON v.brand_id=p.brand_id AND v.generation=p.generation
      WHERE p.brand_id=$1 AND p.workspace_id=$2`, [brandId, workspaceId]);
  return p ? { stages: Number(p.stage_count), separationOfDuties: p.separation_of_duties } : { stages: legacyRequired ? 1 : 0, separationOfDuties: false };
}

// ------------------------------------------------------------------ brand duplicate window setting
export const duplicateWindowSchema = z.object({ duplicate_window_hours: z.number().int().min(0).max(720) }).strict();

export async function getDuplicateWindow(ctx: Ctx, brandId: string, db: Queryable = getPool()) {
  const b = await assertBrand(ctx, brandId, db);
  const r = await maybeOne<{ duplicate_window_hours: number }>(db, `SELECT duplicate_window_hours FROM brands WHERE id=$1`, [b.id]);
  return { brand_id: b.id, duplicate_window_hours: r?.duplicate_window_hours ?? 24, can_edit: authorizeCtx(ctx, 'brands.manage', { brandId: b.id }).allowed };
}

/** brands.manage on the brand; audited. 0 disables the warning for this brand. */
export async function setDuplicateWindow(ctx: Ctx, brandId: string, raw: unknown) {
  const { duplicate_window_hours } = duplicateWindowSchema.parse(raw);
  const visible = await assertBrand(ctx, brandId); // 404 outside the caller's reach
  requireAction(ctx, 'brands.manage', { brandId: visible.id });
  await withTx(async (tx) => {
    const b = await assertBrand(ctx, visible.id, tx);
    const prev = await maybeOne<{ duplicate_window_hours: number }>(tx, `SELECT duplicate_window_hours FROM brands WHERE id=$1 FOR UPDATE`, [b.id]);
    await tx.query(`UPDATE brands SET duplicate_window_hours=$2 WHERE id=$1 AND workspace_id=$3`, [b.id, duplicate_window_hours, ctx.access.workspaceId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: b.id, actorUserId: ctx.actor.userId, action: 'brand.duplicate_window_updated', resourceType: 'brand', resourceId: b.id,
      diff: { before: prev?.duplicate_window_hours ?? null, after: duplicate_window_hours }, correlationId: ctx.correlationId });
  });
  return getDuplicateWindow(ctx, brandId);
}
