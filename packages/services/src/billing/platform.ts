// Platform billing administration (brief V4 §14). Staff roles: 'operator' ⊇ all; 'billing' = billing records + plan/trial
// actions (no customer content, no ticket notes, no support access); 'support' = no billing records (gets only the
// metadata summary via workspaceCommercialSummary). Changes need a fresh MFA sign-in (requireFresh), a reason, and write
// BOTH audits (platform + workspace). Refunds/disputes are not implemented here: staff open the provider's record.
// Service suspension (workspaces.state) and billing cancellation are separate actions; neither implies the other.
import { z } from 'zod';
import { AppError, notFound } from '@social-lite/core';
import { PLANS, type PlanId } from '@social-lite/core/contracts/v4-plans';
import type { PlatformBillingDetailDto, PlatformBillingListItem } from '@social-lite/core/contracts/v4-billing-dto';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import { audit } from '../audit.js';
import { assertUuid } from '../tenancy.js';
import { platformAudit, requireFresh, requirePlatform, type PlatformCtx } from '../admin/platform.js';
import { listCatalogue, publishVersionTx, versionById } from './catalogue.js';
import { invoiceDto, reconcileWorkspace } from './manage.js';
import { MAX_TRIAL_EXTENSIONS } from './policy.js';
import { getBillingProvider, requireBillingProvider } from './provider.js';
import { seatCount } from './seats.js';
import { getBillingState } from './state.js';
import { applySubscription } from './sync.js';
import { extendTrialTx, trialRedemption } from './trials.js';
import { legacyRow, loadBilling, withBillingLock } from './store.js';

const reason = z.string().trim().min(10, 'Give a reason (10+ characters)').max(500);
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

const listQuery = z.object({
  status: z.enum(['trialing', 'active', 'payment_action_required', 'past_due', 'cancel_scheduled', 'cancelled', 'expired', 'incomplete', 'none', 'legacy', 'attention']).optional().nullable(),
  q: z.string().trim().max(80).optional().nullable(),
  limit: z.coerce.number().int().min(1).max(100).optional().nullable(),
});

export async function listPlatformBilling(p: PlatformCtx, raw: unknown, db: Queryable = getPool()): Promise<{ items: PlatformBillingListItem[]; counts: Record<string, number> }> {
  requirePlatform(p, 'billing');
  const q = listQuery.parse(raw ?? {});
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.status === 'attention') where.push(`(b.status IN ('past_due','payment_action_required','incomplete') OR (b.status='trialing' AND b.trial_ends_at < now() + interval '3 days'))`);
  else if (q.status === 'legacy') where.push(`(b.status='legacy' OR b.workspace_id IS NULL)`);
  else if (q.status) { params.push(q.status); where.push(`b.status=$${params.length}`); }
  if (q.q) { params.push(`%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); where.push(`w.name ILIKE $${params.length}`); }
  params.push(q.limit ?? 50);
  const rows = await many<{ workspace_id: string; name: string; plan_id: PlanId | null; status: string | null; access_level: string | null; seats: number | null; trial_ends_at: Date | null;
    current_period_end: Date | null; grace_ends_at: Date | null; cancel_at: Date | null; updated_at: Date | null }>(db,
    `SELECT w.id workspace_id, w.name, b.plan_id, b.status, b.access_level, b.seats, b.trial_ends_at, b.current_period_end, b.grace_ends_at, b.cancel_at, b.updated_at
       FROM workspaces w LEFT JOIN workspace_billing b ON b.workspace_id=w.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY b.updated_at DESC NULLS LAST, w.name LIMIT $${params.length}`, params);
  const counts = await many<{ status: string; n: number }>(db, `SELECT coalesce(b.status,'legacy') status, count(*)::int n FROM workspaces w LEFT JOIN workspace_billing b ON b.workspace_id=w.id GROUP BY 1`);
  return {
    items: rows.map((r) => ({
      workspace_id: r.workspace_id, name: r.name, plan_id: r.plan_id ?? 'legacy', status: (r.status ?? 'legacy') as PlatformBillingListItem['status'],
      access: (r.access_level ?? 'full') as PlatformBillingListItem['access'], seats: r.seats ?? 0, trial_ends_at: iso(r.trial_ends_at), current_period_end: iso(r.current_period_end),
      grace_ends_at: iso(r.grace_ends_at), cancel_at: iso(r.cancel_at), updated_at: iso(r.updated_at),
    })),
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
  };
}

export async function platformBillingDetail(p: PlatformCtx, workspaceId: string, db: Queryable = getPool()): Promise<PlatformBillingDetailDto> {
  requirePlatform(p, 'billing');
  assertUuid(workspaceId, 'Workspace');
  const w = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE id=$1`, [workspaceId]);
  if (!w) throw notFound('Workspace');
  const b = (await loadBilling(db, workspaceId)) ?? legacyRow(workspaceId);
  const state = await getBillingState(db, workspaceId);
  const seats = await seatCount(db, workspaceId);
  const red = await trialRedemption(db, workspaceId);
  const redeemer = red?.redeemed_by ? await maybeOne<{ email: string }>(db, `SELECT email::text FROM users WHERE id=$1`, [red.redeemed_by]) : null;
  const provider = getBillingProvider();
  const sameProvider = !!provider && b.provider === provider.name;
  const version = b.plan_version_id ? await versionById(db, b.plan_version_id) : null;
  const invoices = await many<Parameters<typeof invoiceDto>[0]>(db, `SELECT * FROM billing_invoices WHERE workspace_id=$1 ORDER BY provider_created_at DESC LIMIT 20`, [workspaceId]);
  const lifecycle = await many<{ id: string; created_at: Date; kind: string; from_status: string | null; to_status: string | null; from_plan: string | null; to_plan: string | null; seats: number | null;
    source: string; actor: string | null; reason: string | null }>(db,
    `SELECT e.id::text, e.created_at, e.kind, e.from_status, e.to_status, e.from_plan, e.to_plan, e.seats, e.source, coalesce(u.email::text, e.actor_service) actor, e.reason
       FROM billing_lifecycle_events e LEFT JOIN users u ON u.id=e.actor_user_id WHERE e.workspace_id=$1 ORDER BY e.id DESC LIMIT 50`, [workspaceId]);
  const failures = await many<{ id: string; type: string; attempts: number; last_error: string | null; received_at: Date }>(db,
    `SELECT id::text, type, attempts, last_error, received_at FROM billing_webhook_events WHERE workspace_id=$1 AND status='failed' ORDER BY id DESC LIMIT 10`, [workspaceId]);
  const scheduled = await many<{ id: string; action: string; run_at: Date; reason: string; status: string; created_by: string | null }>(db,
    `SELECT s.id, s.action, s.run_at, s.reason, s.status, u.email::text created_by FROM billing_scheduled_actions s LEFT JOIN users u ON u.id=s.created_by
      WHERE s.workspace_id=$1 ORDER BY s.created_at DESC LIMIT 10`, [workspaceId]);
  const dups = await many<{ sub: string }>(db, `SELECT DISTINCT detail->>'subscription' sub FROM billing_lifecycle_events WHERE workspace_id=$1 AND kind='duplicate_subscription'`, [workspaceId]);
  const liveSub = !!b.provider_subscription_ref && !!b.provider_status && !['canceled', 'incomplete_expired'].includes(b.provider_status);
  return {
    workspace_id: workspaceId, state, plan_name: state.plan_id ? PLANS[state.plan_id].name : null, plan_version: version?.version ?? null,
    seats: { paid: state.seats, billable: seats.billable, members: seats.members, free_guests: seats.free_guests, billable_guests: seats.billable_guests,
      pending_member_invites: seats.pending_member_invites, support_operators: seats.support_operators },
    provider: {
      name: b.provider, livemode: b.livemode, customer_ref: b.provider_customer_ref, subscription_ref: b.provider_subscription_ref, provider_status: b.provider_status,
      customer_url: sameProvider && b.provider_customer_ref ? provider!.dashboardUrl('customer', b.provider_customer_ref) : null,
      subscription_url: sameProvider && b.provider_subscription_ref ? provider!.dashboardUrl('subscription', b.provider_subscription_ref) : null,
      synced_at: iso(b.provider_synced_at),
    },
    trial: red ? {
      started_at: red.started_at.toISOString(), ends_at: red.ends_at.toISOString(), original_ends_at: red.original_ends_at.toISOString(), extensions: red.extensions,
      redeemed_by: redeemer?.email ?? null, source: red.source,
      eligible_for_extension: red.extensions < MAX_TRIAL_EXTENSIONS && !liveSub && ['trialing', 'expired'].includes(b.status),
    } : null,
    payment_issue: ['past_due', 'payment_action_required', 'incomplete'].includes(b.status) ? { since: iso(b.past_due_since), grace_ends_at: iso(b.grace_ends_at), action_required: b.payment_action_required } : null,
    invoices: invoices.map((i) => ({ ...invoiceDto(i), provider_url: sameProvider ? provider!.dashboardUrl('invoice', i.provider_invoice_ref) : null })),
    lifecycle: lifecycle.map(({ created_at, ...r }) => ({ ...r, at: created_at.toISOString() })),
    webhook_failures: failures.map((f) => ({ ...f, received_at: f.received_at.toISOString() })),
    scheduled_actions: scheduled.map((s) => ({ ...s, run_at: s.run_at.toISOString() })),
    duplicate_subscriptions: dups.map((d) => d.sub).filter(Boolean),
    can_act: p.role === 'operator' || p.role === 'billing',
  };
}

// ------------------------------------------------------------------ actions
const extendSchema = z.object({ days: z.number().int().min(1).max(30), reason }).strict();

export async function staffExtendTrial(p: PlatformCtx, workspaceId: string, raw: unknown) {
  requirePlatform(p, 'billing');
  requireFresh(p);
  assertUuid(workspaceId, 'Workspace');
  const input = extendSchema.parse(raw);
  return withTx(async (tx) => {
    const r = await extendTrialTx(tx, { workspaceId, days: input.days, userId: p.actor.userId, reason: input.reason });
    const diff = { from: r.from.toISOString(), to: r.to.toISOString(), days: input.days };
    await platformAudit(tx, p, { action: 'billing.trial_extended', targetType: 'workspace', targetId: workspaceId, workspaceId, reason: input.reason, diff });
    await audit(tx, { workspaceId, actorUserId: p.actor.userId, action: 'platform.billing_trial_extended', resourceType: 'workspace_billing', resourceId: workspaceId, diff: { ...diff, reason: input.reason }, correlationId: p.correlationId });
    return { ok: true as const, trial_ends_at: r.to.toISOString() };
  });
}

const cancelSchema = z.object({ cancel: z.boolean(), reason }).strict();

/** Staff cancel-at-period-end / resume renewal through the provider (billing only — the service is NOT suspended). */
export async function staffSetRenewal(p: PlatformCtx, workspaceId: string, raw: unknown) {
  requirePlatform(p, 'billing');
  requireFresh(p);
  assertUuid(workspaceId, 'Workspace');
  const input = cancelSchema.parse(raw);
  return withBillingLock(workspaceId, async () => {
    const b = await loadBilling(getPool(), workspaceId);
    if (!b?.provider_subscription_ref || !b.provider_status || ['canceled', 'incomplete_expired'].includes(b.provider_status)) throw new AppError('invalid_state', 'There is no live subscription.');
    if (b.cancel_at_period_end === input.cancel) throw new AppError('invalid_state', input.cancel ? 'Renewal is already cancelled.' : 'Renewal is not cancelled.');
    const provider = requireBillingProvider();
    const sub = await provider.updateSubscription({ subscriptionRef: b.provider_subscription_ref, cancelAtPeriodEnd: input.cancel, idempotencyKey: `relay-staff-renewal-${workspaceId}-${b.version}` });
    return withTx(async (tx) => {
      const r = await applySubscription(tx, workspaceId, sub, { provider: provider.name, entry: { kind: input.cancel ? 'staff.cancellation_scheduled' : 'staff.renewal_resumed', source: 'staff', actorUserId: p.actor.userId, reason: input.reason } });
      const diff = { cancel_at: iso(r.row.cancel_at), status: r.row.status };
      await platformAudit(tx, p, { action: input.cancel ? 'billing.cancel_scheduled' : 'billing.renewal_resumed', targetType: 'workspace', targetId: workspaceId, workspaceId, reason: input.reason, diff });
      await audit(tx, { workspaceId, actorUserId: p.actor.userId, action: input.cancel ? 'platform.billing_cancel_scheduled' : 'platform.billing_renewal_resumed', resourceType: 'workspace_billing', resourceId: workspaceId, diff: { ...diff, reason: input.reason }, correlationId: p.correlationId });
      return { ok: true as const, ...diff };
    });
  });
}

/** Re-fetch from the provider now (read-only towards the provider). */
export async function staffReconcile(p: PlatformCtx, workspaceId: string) {
  requirePlatform(p, 'billing');
  assertUuid(workspaceId, 'Workspace');
  const r = await reconcileWorkspace(workspaceId, { source: 'staff', actorUserId: p.actor.userId });
  await platformAudit(getPool(), p, { action: 'billing.reconciled', targetType: 'workspace', targetId: workspaceId, workspaceId, diff: r });
  return { ok: true as const, ...r };
}

const scheduleSchema = z.object({ action: z.literal('suspend'), run_at: z.string().datetime({ offset: true }), reason }).strict();

/** Schedule a SERVICE suspension (e.g. after an unresolved payment issue). Operator only: suspension is a lifecycle power. */
export async function scheduleLifecycleAction(p: PlatformCtx, workspaceId: string, raw: unknown) {
  requirePlatform(p, 'operator');
  requireFresh(p);
  assertUuid(workspaceId, 'Workspace');
  const input = scheduleSchema.parse(raw);
  const runAt = new Date(input.run_at);
  if (runAt.getTime() < Date.now() + 5 * 60_000 || runAt.getTime() > Date.now() + 365 * 86400_000) throw new AppError('validation_failed', 'Pick a time between 5 minutes and a year from now', { run_at: 'Out of range' });
  return withTx(async (tx) => {
    const w = await maybeOne<{ state: string }>(tx, `SELECT state FROM workspaces WHERE id=$1 FOR UPDATE`, [workspaceId]);
    if (!w) throw notFound('Workspace');
    if (w.state === 'suspended') throw new AppError('invalid_state', 'This workspace is already suspended.');
    const r = await one<{ id: string }>(tx, `INSERT INTO billing_scheduled_actions(workspace_id, action, run_at, reason, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [workspaceId, input.action, runAt, input.reason, p.actor.userId]).catch((e) => { if ((e as { code?: string }).code === '23505') throw new AppError('conflict', 'A suspension is already scheduled. Cancel it first.'); throw e; });
    await platformAudit(tx, p, { action: 'lifecycle.suspension_scheduled', targetType: 'workspace', targetId: workspaceId, workspaceId, reason: input.reason, diff: { run_at: runAt.toISOString(), id: r.id } });
    await audit(tx, { workspaceId, actorUserId: p.actor.userId, action: 'platform.suspension_scheduled', resourceType: 'workspace', resourceId: workspaceId, diff: { run_at: runAt.toISOString(), reason: input.reason }, correlationId: p.correlationId });
    return { ok: true as const, id: r.id, run_at: runAt.toISOString() };
  });
}

export async function cancelLifecycleAction(p: PlatformCtx, workspaceId: string, actionId: string, raw: unknown) {
  requirePlatform(p, 'operator');
  requireFresh(p);
  assertUuid(workspaceId, 'Workspace');
  assertUuid(actionId, 'Scheduled action');
  const { reason: why } = z.object({ reason }).strict().parse(raw);
  return withTx(async (tx) => {
    const r = await tx.query(`UPDATE billing_scheduled_actions SET status='cancelled', cancelled_by=$3 WHERE id=$1 AND workspace_id=$2 AND status='scheduled'`, [actionId, workspaceId, p.actor.userId]);
    if (!r.rowCount) throw notFound('Scheduled action');
    await platformAudit(tx, p, { action: 'lifecycle.scheduled_action_cancelled', targetType: 'workspace', targetId: workspaceId, workspaceId, reason: why, diff: { id: actionId } });
    await audit(tx, { workspaceId, actorUserId: p.actor.userId, action: 'platform.scheduled_action_cancelled', resourceType: 'workspace', resourceId: workspaceId, diff: { id: actionId, reason: why }, correlationId: p.correlationId });
    return { ok: true as const };
  });
}

// ------------------------------------------------------------------ catalogue
export async function platformPlans(p: PlatformCtx, db: Queryable = getPool()) {
  requirePlatform(p, 'staff');
  const provider = getBillingProvider();
  return { plans: await listCatalogue(db), provider: provider ? { name: provider.name, livemode: provider.livemode } : null, can_edit: p.role === 'operator' || p.role === 'billing' };
}

const priceSchema = z.object({
  plan_version_id: z.string().uuid(), provider: z.literal('stripe'), livemode: z.boolean(),
  price_ref: z.string().trim().regex(/^price_[A-Za-z0-9]{6,100}$/, 'Stripe price ids start with price_'), product_ref: z.string().trim().regex(/^prod_[A-Za-z0-9]{6,100}$/).optional().nullable(), reason,
}).strict();

/**
 * Map a plan version to a Stripe price id (activation step). The price must be created in Stripe with the SAME amount,
 * currency (GBP) and monthly interval as the version; replacing a mapping retires the old one for new checkouts only.
 */
export async function mapProviderPrice(p: PlatformCtx, raw: unknown) {
  requirePlatform(p, 'billing');
  requireFresh(p);
  const input = priceSchema.parse(raw);
  return withTx(async (tx) => {
    const v = await versionById(tx, input.plan_version_id);
    if (!v || !v.purchasable) throw new AppError('validation_failed', 'Only purchasable plan versions can be mapped', { plan_version_id: 'Not purchasable' });
    await tx.query(`UPDATE billing_provider_prices SET retired_at=now() WHERE provider=$1 AND livemode=$2 AND plan_version_id=$3 AND retired_at IS NULL`, [input.provider, input.livemode, v.id]);
    await tx.query(`INSERT INTO billing_provider_prices(plan_version_id, provider, livemode, price_ref, product_ref, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [v.id, input.provider, input.livemode, input.price_ref, input.product_ref ?? null, p.actor.userId]).catch((e) => { if ((e as { code?: string }).code === '23505') throw new AppError('conflict', 'That price id is already mapped.'); throw e; });
    await platformAudit(tx, p, { action: 'billing.price_mapped', targetType: 'plan_version', targetId: v.id, reason: input.reason,
      diff: { plan: v.plan_id, version: v.version, provider: input.provider, livemode: input.livemode, price_ref: input.price_ref } });
    return { ok: true as const };
  });
}

export async function publishPlanVersion(p: PlatformCtx, raw: unknown) {
  requirePlatform(p, 'operator');
  requireFresh(p);
  const input = z.object({ plan_id: z.enum(['standard', 'professional', 'legacy']), reason }).strict().parse(raw);
  return withTx(async (tx) => {
    const v = await publishVersionTx(tx, input.plan_id, p.actor.userId);
    await platformAudit(tx, p, { action: 'billing.plan_version_published', targetType: 'plan_version', targetId: v.id, reason: input.reason, diff: { plan: v.plan_id, version: v.version, unit_amount_minor: v.unit_amount_minor } });
    return { ok: true as const, id: v.id, version: v.version };
  });
}
