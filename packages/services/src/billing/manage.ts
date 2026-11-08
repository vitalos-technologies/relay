// Customer billing self-service (brief V4 §11; V5 §8): overview, trial start / trial plan switch, hosted checkout,
// customer portal, plan/seat change with provider preview, cancel renewal, reactivate, invoices, reconciliation.
// Authority: billing.read (view) / billing.manage (act; sensitive ⇒ MFA by policy). Billing never implies content access.
// No provider call happens during page render: the overview reads stored state; refresh() is a separate async request.
import { z } from 'zod';
import { AppError } from '@social-lite/core';
import { PLANS, PUBLIC_PLAN_IDS, publicCatalogue, type PlanId } from '@social-lite/core/contracts/v4-plans';
import type { BillingChangePreviewDto, BillingInvoiceDto, BillingOverviewDto } from '@social-lite/core/contracts/v4-billing-dto';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { authorizeCtx, requireAction } from '../tenancy.js';
import { currentVersion, priceRefFor, versionById } from './catalogue.js';
import { CHECKOUT_TTL_MS, checkoutTiming, classifyChange, hasPaidSubscription } from './policy.js';
import { appUrl, billingProviderStatus, getBillingProvider, requireBillingProvider } from './provider.js';
import { billableSeats, requiredSeats, seatCount } from './seats.js';
import { getBillingState } from './state.js';
import { applyInvoice, applySubscription } from './sync.js';
import { changeTrialPlanTx, startTrialTx, trialRedemption } from './trials.js';
import { legacyRow, loadBilling, lockBilling, saveBilling, withBillingLock, type BillingRow } from './store.js';

const LIVE_PROVIDER: readonly string[] = ['trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused'];
const planSchema = z.enum(PUBLIC_PLAN_IDS);
const seatsSchema = z.number().int().min(1).max(10000);

function liveSub(b: BillingRow): boolean {
  return !!b.provider_subscription_ref && !!b.provider_status && LIVE_PROVIDER.includes(b.provider_status);
}
function canManage(ctx: Ctx): boolean {
  try { return authorizeCtx(ctx, 'billing.manage').allowed; } catch { return false; }
}
async function unitOf(db: Queryable, b: BillingRow): Promise<number | null> {
  if (b.plan_version_id) { const v = await versionById(db, b.plan_version_id); if (v) return v.unit_amount_minor; }
  return PLANS[b.plan_id].unit_amount_minor;
}
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

export function invoiceDto(r: { provider_invoice_ref: string; number: string | null; status: string; currency: string; amount_due_minor: number; amount_paid_minor: number; total_minor: number;
  hosted_url: string | null; pdf_url: string | null; period_start: Date | null; period_end: Date | null; provider_created_at: Date; provider: string }): BillingInvoiceDto {
  return { id: r.provider_invoice_ref, number: r.number, status: r.status, currency: r.currency, amount_due_minor: r.amount_due_minor, amount_paid_minor: r.amount_paid_minor,
    total_minor: r.total_minor, hosted_url: r.hosted_url, pdf_url: r.pdf_url, period_start: iso(r.period_start), period_end: iso(r.period_end),
    created_at: r.provider_created_at.toISOString(), test_mode: r.provider === 'test' };
}

export async function billingOverview(ctx: Ctx, db: Queryable = getPool()): Promise<BillingOverviewDto> {
  requireAction(ctx, 'billing.read');
  const ws = ctx.access.workspaceId;
  const b = (await loadBilling(db, ws)) ?? legacyRow(ws);
  const state = await getBillingState(db, ws);
  const seats = await seatCount(db, ws);
  const red = await trialRedemption(db, ws);
  const status = billingProviderStatus();
  const unit = state.plan_id ? await unitOf(db, b) : null;
  const version = b.plan_version_id ? await versionById(db, b.plan_version_id) : null;
  // No live subscription (trial / legacy / ended): what a subscription would carry now = the current billable users.
  const paidSeats = liveSub(b) ? state.seats : requiredSeats(seats.billable);
  const open = await maybeOne<{ url: string | null; expires_at: Date }>(db,
    `SELECT url, expires_at FROM billing_checkout_sessions WHERE workspace_id=$1 AND status='open' AND expires_at > now() + interval '1 minute'`, [ws]);
  const invoices = await many<Parameters<typeof invoiceDto>[0]>(db,
    `SELECT * FROM billing_invoices WHERE workspace_id=$1 ORDER BY provider_created_at DESC LIMIT 12`, [ws]);
  const sub = liveSub(b);
  const trialRunning = state.status === 'trialing' && !!b.trial_ends_at && b.trial_ends_at.getTime() > Date.now();
  const manage = canManage(ctx);
  const sched = state.scheduled_change;
  const firstCharge = sub && b.provider_status === 'trialing' ? (b.trial_ends_at ?? b.current_period_end) : null;
  return {
    state,
    provider: { name: status.provider, configured: status.configured, test_mode: status.test_mode },
    plan: state.plan_id ? { id: state.plan_id, name: PLANS[state.plan_id].name, unit_amount_minor: unit, currency: 'GBP', interval: 'month', version: version?.version ?? null } : null,
    trial: b.trial_started_at && b.trial_ends_at ? {
      started_at: b.trial_started_at.toISOString(), ends_at: b.trial_ends_at.toISOString(), plan_id: b.trial_plan_id ?? b.plan_id,
      days_left: Math.max(0, Math.ceil((b.trial_ends_at.getTime() - Date.now()) / 86400_000)), redeemed: true,
    } : null,
    trial_used: !!red,
    seats: { paid: liveSub(b) ? state.seats : 0, billable: seats.billable, members: seats.members, free_guests: seats.free_guests, billable_guests: seats.billable_guests,
      pending_member_invites: seats.pending_member_invites, support_operators: seats.support_operators },
    recurring_total_minor: unit != null && state.plan_id !== 'legacy' ? unit * paidSeats : null,
    next_charge_at: sub && !b.cancel_at_period_end ? iso(firstCharge ?? b.current_period_end) : null,
    first_charge_at: iso(firstCharge),
    payment_method: b.payment_method,
    scheduled_change: sched ? { plan_id: sched.plan_id, plan_name: sched.plan_id ? PLANS[sched.plan_id].name : null, seats: sched.seats, effective_at: sched.effective_at } : null,
    open_checkout: open?.url ? { url: open.url, expires_at: open.expires_at.toISOString() } : null,
    catalogue: publicCatalogue(),
    invoices: invoices.map(invoiceDto),
    can_manage: manage,
    actions: {
      start_trial: manage && !red && (state.status === 'none'),
      change_trial_plan: manage && trialRunning && !sub,
      checkout: manage && status.configured && !sub,
      change_subscription: manage && status.configured && sub && b.provider_status !== 'incomplete',
      cancel: manage && status.configured && sub && !b.cancel_at_period_end && ['active', 'trialing', 'past_due', 'payment_action_required'].includes(state.status),
      reactivate: manage && status.configured && sub && state.status === 'cancel_scheduled',
      portal: manage && status.configured && !!b.provider_customer_ref && b.provider === status.provider,
    },
    last_synced_at: iso(b.provider_synced_at),
    version: b.version,
  };
}

// ------------------------------------------------------------------ trial
export async function startTrial(ctx: Ctx, raw: unknown) {
  requireAction(ctx, 'billing.manage');
  const { plan } = z.object({ plan: planSchema }).strict().parse(raw);
  return withTx(async (tx) => {
    const row = await startTrialTx(tx, { workspaceId: ctx.access.workspaceId, planId: plan, userId: ctx.actor.userId, source: 'settings' });
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'billing.trial_started', resourceType: 'workspace_billing',
      resourceId: ctx.access.workspaceId, diff: { plan, ends_at: iso(row.trial_ends_at) }, correlationId: ctx.correlationId });
    return { ok: true as const, trial_ends_at: iso(row.trial_ends_at) };
  });
}

export async function changeTrialPlan(ctx: Ctx, raw: unknown) {
  requireAction(ctx, 'billing.manage');
  const { plan } = z.object({ plan: planSchema }).strict().parse(raw);
  return withTx(async (tx) => {
    const row = await changeTrialPlanTx(tx, { workspaceId: ctx.access.workspaceId, planId: plan, userId: ctx.actor.userId });
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'billing.trial_plan_changed', resourceType: 'workspace_billing',
      resourceId: ctx.access.workspaceId, diff: { plan, trial_ends_at: iso(row.trial_ends_at) }, correlationId: ctx.correlationId });
    return { ok: true as const, plan_id: row.plan_id, trial_ends_at: iso(row.trial_ends_at) };
  });
}

// ------------------------------------------------------------------ checkout
const checkoutSchema = z.object({ plan: planSchema, seats: seatsSchema.optional() }).strict();

export interface CheckoutResult { url: string; expires_at: string; reused: boolean; seats: number; recurring_total_minor: number; first_charge_at: string; test_mode: boolean }

/**
 * Start (or reuse) the workspace's one open hosted checkout. Repeated clicks return the same session; a live subscription
 * refuses a second checkout. The success redirect is never evidence: activation comes only from verified provider state.
 */
export async function startCheckout(ctx: Ctx, raw: unknown): Promise<CheckoutResult> {
  requireAction(ctx, 'billing.manage');
  const input = checkoutSchema.parse(raw);
  const provider = requireBillingProvider();
  const ws = ctx.access.workspaceId;
  return withBillingLock(ws, async () => {
    const db = getPool();
    const version = await currentVersion(db, input.plan);
    const priceRef = await priceRefFor(db, provider.name, provider.livemode, version.id);
    const billable = await billableSeats(db, ws);
    const seats = Math.max(requiredSeats(billable), input.seats ?? 0);
    const open = await maybeOne<{ id: string; status: string; url: string | null; expires_at: Date; plan_version_id: string; seats: number; provider_session_ref: string | null; first_charge_at: Date | null; provider: string }>(db,
      `SELECT id, status, url, expires_at, plan_version_id, seats, provider_session_ref, first_charge_at, provider FROM billing_checkout_sessions WHERE workspace_id=$1 AND status IN ('pending','open')`, [ws]);
    if (open && open.status === 'open' && open.url && open.expires_at.getTime() > Date.now() + 5 * 60_000 && open.plan_version_id === version.id && open.seats === seats && open.provider === provider.name) {
      return { url: open.url, expires_at: open.expires_at.toISOString(), reused: true, seats, recurring_total_minor: version.unit_amount_minor! * seats,
        first_charge_at: (open.first_charge_at ?? new Date()).toISOString(), test_mode: !provider.livemode };
    }
    if (open) {
      if (open.provider_session_ref && open.provider === provider.name) await provider.expireCheckoutSession(open.provider_session_ref).catch(() => undefined);
      await db.query(`UPDATE billing_checkout_sessions SET status='cancelled' WHERE id=$1 AND status IN ('pending','open')`, [open.id]);
    }
    const b = (await loadBilling(db, ws)) ?? legacyRow(ws);
    if (liveSub(b) && b.provider === provider.name) throw new AppError('conflict', 'This workspace already has a subscription. Change its plan or seats instead.', undefined, { reason: 'already_subscribed' });
    const trialRunning = b.status === 'trialing' && !!b.trial_ends_at && b.trial_ends_at.getTime() > Date.now();
    const timing = checkoutTiming(trialRunning ? b.trial_ends_at : null, new Date());
    const expiresAt = new Date(Date.now() + CHECKOUT_TTL_MS);
    const reserved = await withTx(async (tx) => {
      const row = await lockBilling(tx, ws);
      const r = await one<{ id: string }>(tx,
        `INSERT INTO billing_checkout_sessions(workspace_id, provider, livemode, plan_version_id, seats, first_charge_at, status, created_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8) RETURNING id`, [ws, provider.name, provider.livemode, version.id, seats, timing.firstChargeAt, ctx.actor.userId, expiresAt])
        .catch((e) => { if ((e as { code?: string }).code === '23505') throw new AppError('conflict', 'A checkout is already being prepared. Try again in a moment.'); throw e; });
      return { id: r.id, customer: row.provider === provider.name ? row.provider_customer_ref : null };
    });
    try {
      let customer = reserved.customer;
      if (!customer) {
        const w = await one<{ name: string }>(db, `SELECT name FROM workspaces WHERE id=$1`, [ws]);
        customer = (await provider.createCustomer({ workspaceId: ws, name: w.name, email: ctx.actor.email || null, idempotencyKey: `relay-customer-${provider.name}-${ws}` })).ref;
        await db.query(`UPDATE workspace_billing SET provider=$2, livemode=$3, provider_customer_ref=$4, updated_at=now() WHERE workspace_id=$1`, [ws, provider.name, provider.livemode, customer]);
      }
      const session = await provider.createCheckoutSession({
        customerRef: customer, priceRef, quantity: seats, workspaceId: ws, checkoutId: reserved.id, trialEnd: timing.trialEnd, billingCycleAnchor: timing.billingCycleAnchor,
        successUrl: appUrl('/settings/workspace/billing?checkout=returned&session={CHECKOUT_SESSION_ID}'), cancelUrl: appUrl('/settings/workspace/billing?checkout=cancelled'),
        expiresAt, idempotencyKey: `relay-checkout-${reserved.id}`,
      });
      await withTx(async (tx) => {
        await tx.query(`UPDATE billing_checkout_sessions SET status='open', provider_session_ref=$2, url=$3 WHERE id=$1`, [reserved.id, session.ref, session.url]);
        await tx.query(`INSERT INTO billing_lifecycle_events(workspace_id, kind, from_status, to_status, to_plan, seats, source, actor_user_id, detail) VALUES ($1,'checkout_started',$2,$2,$3,$4,'user',$5,$6)`,
          [ws, b.status, input.plan, seats, ctx.actor.userId, JSON.stringify({ first_charge_at: timing.firstChargeAt.toISOString() })]);
        await audit(tx, { workspaceId: ws, actorUserId: ctx.actor.userId, action: 'billing.checkout_started', resourceType: 'workspace_billing', resourceId: ws,
          diff: { plan: input.plan, seats, first_charge_at: timing.firstChargeAt.toISOString(), test_mode: !provider.livemode }, correlationId: ctx.correlationId });
      });
      return { url: session.url!, expires_at: expiresAt.toISOString(), reused: false, seats, recurring_total_minor: version.unit_amount_minor! * seats,
        first_charge_at: timing.firstChargeAt.toISOString(), test_mode: !provider.livemode };
    } catch (e) {
      await db.query(`UPDATE billing_checkout_sessions SET status='failed', error_code=$2 WHERE id=$1`, [reserved.id, (e as AppError).code ?? 'provider_error']);
      if (e instanceof AppError) throw e;
      throw new AppError('provider_error', 'The payment provider did not respond. Nothing was charged. Try again.');
    }
  });
}

// ------------------------------------------------------------------ reconciliation (provider = evidence)
/**
 * Fetch the workspace's checkout sessions and subscription from the provider and apply them. Used by the "returned from
 * checkout" page (the redirect itself proves nothing), Settings refresh, Platform and the worker sweep.
 */
export async function reconcileWorkspace(workspaceId: string, p: { source: 'user' | 'staff' | 'reconcile'; actorUserId?: string | null } = { source: 'reconcile' }): Promise<{ changed: boolean; status: string }> {
  const provider = getBillingProvider();
  const db = getPool();
  const b = await loadBilling(db, workspaceId);
  if (!provider || !b) return { changed: false, status: b?.status ?? 'legacy' };
  let subRef = b.provider === provider.name ? b.provider_subscription_ref : null;
  const sessions = await many<{ id: string; provider_session_ref: string }>(db,
    `SELECT id, provider_session_ref FROM billing_checkout_sessions WHERE workspace_id=$1 AND provider=$2 AND status='open' AND provider_session_ref IS NOT NULL`, [workspaceId, provider.name]);
  for (const s of sessions) {
    const cs = await provider.retrieveCheckoutSession(s.provider_session_ref);
    if (!cs) continue;
    if (cs.status === 'complete' && cs.subscription_ref) {
      await db.query(`UPDATE billing_checkout_sessions SET status='completed', completed_at=now(), provider_subscription_ref=$2 WHERE id=$1`, [s.id, cs.subscription_ref]);
      if (!subRef || !liveSub(b)) subRef = cs.subscription_ref;
    } else if (cs.status === 'expired' || (cs.expires_at && cs.expires_at.getTime() < Date.now())) {
      await db.query(`UPDATE billing_checkout_sessions SET status='expired' WHERE id=$1`, [s.id]);
    }
  }
  if (!subRef) {
    await db.query(`UPDATE workspace_billing SET provider_synced_at=now() WHERE workspace_id=$1`, [workspaceId]);
    return { changed: false, status: b.status };
  }
  const sub = await provider.retrieveSubscription(subRef);
  if (!sub) return { changed: false, status: b.status };
  const pm = await provider.paymentMethodSummary(sub.customer_ref, sub.ref).catch(() => undefined);
  const inv = sub.latest_invoice_ref ? await provider.retrieveInvoice(sub.latest_invoice_ref).catch(() => null) : null;
  const r = await withTx(async (tx) => {
    if (inv) await applyInvoice(tx, workspaceId, inv, { provider: provider.name, eventType: 'reconcile' });
    return applySubscription(tx, workspaceId, sub, { provider: provider.name, paymentMethod: pm ?? undefined,
      entry: { kind: 'reconciled', source: p.source, actorUserId: p.actorUserId ?? null, actorService: p.source === 'reconcile' ? 'billing-sweep' : null } });
  });
  return { changed: r.changed, status: r.row.status };
}

export async function refreshBilling(ctx: Ctx) {
  requireAction(ctx, 'billing.read');
  const r = await reconcileWorkspace(ctx.access.workspaceId, { source: 'user', actorUserId: ctx.actor.userId });
  const provider = getBillingProvider();
  const b = await loadBilling(getPool(), ctx.access.workspaceId);
  if (provider && b?.provider_customer_ref && b.provider === provider.name) {
    const list = await provider.listInvoices(b.provider_customer_ref, 12).catch(() => []);
    await withTx(async (tx) => { for (const inv of list) await applyInvoice(tx, ctx.access.workspaceId, inv, { provider: provider.name, eventType: 'list' }); });
  }
  return { ok: true as const, ...r };
}

// ------------------------------------------------------------------ portal
const portalSchema = z.object({ flow: z.enum(['payment_method_update', 'subscription_cancel']).nullable().optional() }).strict();

export async function openPortal(ctx: Ctx, raw: unknown): Promise<{ url: string; test_mode: boolean }> {
  requireAction(ctx, 'billing.manage');
  const { flow } = portalSchema.parse(raw ?? {});
  const provider = requireBillingProvider();
  const b = await loadBilling(getPool(), ctx.access.workspaceId);
  if (!b?.provider_customer_ref || b.provider !== provider.name) throw new AppError('invalid_state', 'There are no billing details to manage yet. Start a subscription first.');
  const s = await provider.createPortalSession({ customerRef: b.provider_customer_ref, returnUrl: appUrl('/settings/workspace/billing?portal=returned'), flow: flow ?? null, subscriptionRef: b.provider_subscription_ref });
  await audit(getPool(), { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'billing.portal_opened', resourceType: 'workspace_billing', resourceId: ctx.access.workspaceId,
    diff: { flow: flow ?? null }, correlationId: ctx.correlationId });
  return { url: s.url, test_mode: !provider.livemode };
}

// ------------------------------------------------------------------ plan / seat changes
const changeSchema = z.object({ plan: planSchema, seats: seatsSchema }).strict();

async function planChange(ctx: Ctx, raw: unknown) {
  const input = changeSchema.parse(raw);
  const db = getPool();
  const ws = ctx.access.workspaceId;
  const b = (await loadBilling(db, ws)) ?? legacyRow(ws);
  const version = await currentVersion(db, input.plan);
  const billable = await billableSeats(db, ws);
  if (input.seats < requiredSeats(billable)) {
    throw new AppError('validation_failed', `You have ${billable} billable ${billable === 1 ? 'user' : 'users'}. Remove members first, or keep at least ${requiredSeats(billable)} seats.`, { seats: `At least ${requiredSeats(billable)}` });
  }
  const fromUnit = (await unitOf(db, b)) ?? 0;
  return { input, b, version, fromUnit, toUnit: version.unit_amount_minor!, billable };
}

export async function previewChange(ctx: Ctx, raw: unknown): Promise<BillingChangePreviewDto> {
  requireAction(ctx, 'billing.manage');
  const { input, b, version, fromUnit, toUnit } = await planChange(ctx, raw);
  const from = { plan_id: b.plan_id, seats: b.seats, recurring_minor: b.plan_id === 'legacy' ? null : fromUnit * b.seats };
  const to = { plan_id: input.plan as PlanId, seats: input.seats, recurring_minor: toUnit * input.seats };
  if (!liveSub(b)) {
    if (b.status === 'trialing') {
      return { kind: 'trial', from, to, proration_minor: 0, next_invoice_minor: null, next_invoice_at: null, effective_at: new Date().toISOString(), proration_date: null, currency: 'GBP', lines: [],
        notes: [`Your trial keeps its end date (${b.trial_ends_at?.toISOString().slice(0, 10)}). Nothing is charged.`] };
    }
    throw new AppError('invalid_state', 'Start a subscription first.');
  }
  const provider = requireBillingProvider();
  const providerTrial = b.provider_status === 'trialing';
  const kind = providerTrial ? 'immediate' : classifyChange({ fromUnit, toUnit, fromSeats: b.seats, toSeats: input.seats });
  if (kind === 'mixed') throw new AppError('validation_failed', 'Change the plan and the number of seats separately.');
  if (kind === 'none') return { kind: 'none', from, to, proration_minor: 0, next_invoice_minor: null, next_invoice_at: null, effective_at: new Date().toISOString(), proration_date: null, currency: 'GBP', lines: [], notes: [] };
  const priceRef = await priceRefFor(getPool(), provider.name, provider.livemode, version.id);
  const prorationDate = Math.floor(Date.now() / 1000);
  const pv = await provider.previewChange({ subscriptionRef: b.provider_subscription_ref!, itemRef: b.provider_item_ref!, priceRef, quantity: input.seats, prorationDate,
    prorationBehavior: kind === 'immediate' && !providerTrial ? 'create_prorations' : 'none' });
  const effective = kind === 'scheduled' ? (b.current_period_end ?? new Date()) : new Date();
  const notes = providerTrial ? ['You are still in your free trial. The new price applies from the first charge.']
    : kind === 'immediate' ? ['Applies now. The prorated difference is added to your next invoice.']
    : [`Applies on ${effective.toISOString().slice(0, 10)}. You keep your current plan and seats until then.`, ...(toUnit < fromUnit ? ['Features not in the new plan pause then; nothing is deleted.'] : [])];
  return { kind: providerTrial ? 'immediate' : kind, from, to, proration_minor: kind === 'immediate' && !providerTrial ? pv.proration_minor : 0, next_invoice_minor: pv.next_invoice_minor,
    next_invoice_at: iso(pv.next_invoice_at), effective_at: effective.toISOString(), proration_date: prorationDate, currency: pv.currency, lines: pv.lines, notes };
}

const applySchema = z.object({ plan: planSchema, seats: seatsSchema, proration_date: z.number().int().positive().nullable().optional(), expected_version: z.number().int().min(0) }).strict();

export async function applyChange(ctx: Ctx, raw: unknown, idempotencyKey: string | null) {
  requireAction(ctx, 'billing.manage');
  const parsed = applySchema.parse(raw);
  if (!idempotencyKey || idempotencyKey.length < 8) throw new AppError('validation_failed', 'An Idempotency-Key header (8-200 characters) is required for this request');
  const ws = ctx.access.workspaceId;
  return withBillingLock(ws, async () => {
    const { input, b, version, fromUnit, toUnit } = await planChange(ctx, { plan: parsed.plan, seats: parsed.seats });
    if (b.version !== parsed.expected_version) throw new AppError('conflict', 'Billing changed since you opened this. Review the new details and try again.', undefined, { reason: 'stale' });
    if (!liveSub(b)) {
      if (b.status !== 'trialing') throw new AppError('invalid_state', 'Start a subscription first.');
      const row = await withTx((tx) => changeTrialPlanTx(tx, { workspaceId: ws, planId: input.plan, userId: ctx.actor.userId }));
      return { ok: true as const, kind: 'trial' as const, plan_id: row.plan_id, seats: row.seats };
    }
    const provider = requireBillingProvider();
    const providerTrial = b.provider_status === 'trialing';
    const kind = providerTrial ? 'immediate' : classifyChange({ fromUnit, toUnit, fromSeats: b.seats, toSeats: input.seats });
    if (kind === 'mixed') throw new AppError('validation_failed', 'Change the plan and the number of seats separately.');
    if (kind === 'none') return { ok: true as const, kind: 'none' as const, plan_id: b.plan_id, seats: b.seats };
    const priceRef = await priceRefFor(getPool(), provider.name, provider.livemode, version.id);
    // A scheduled change is recorded BEFORE the provider update: the provider's webhook for that update can arrive before
    // our own transaction commits, and must then already see the schedule (so it keeps current entitlements).
    if (kind === 'scheduled') {
      await withTx(async (tx) => {
        const prev = await lockBilling(tx, ws);
        const effective = prev.current_period_end ?? new Date();
        const next: BillingRow = { ...prev, scheduled_plan_version_id: version.id !== prev.plan_version_id ? version.id : null, scheduled_seats: input.seats !== prev.seats ? input.seats : null, scheduled_effective_at: effective };
        await saveBilling(tx, prev, next, { kind: 'change_scheduled', source: 'user', actorUserId: ctx.actor.userId, detail: { plan: input.plan, seats: input.seats, effective_at: effective.toISOString() } }, ['billing.subscription_changed']);
      });
    }
    let sub;
    try {
      sub = await provider.updateSubscription({
        subscriptionRef: b.provider_subscription_ref!, itemRef: b.provider_item_ref, priceRef, quantity: input.seats,
        prorationBehavior: kind === 'immediate' && !providerTrial ? 'create_prorations' : 'none', prorationDate: kind === 'immediate' && !providerTrial ? parsed.proration_date ?? null : null,
        idempotencyKey: `relay-change-${ws}-${idempotencyKey}`.slice(0, 255),
      });
    } catch (e) {
      if (kind === 'scheduled') {
        await withTx(async (tx) => {
          const prev = await lockBilling(tx, ws);
          await saveBilling(tx, prev, { ...prev, scheduled_plan_version_id: null, scheduled_seats: null, scheduled_effective_at: null }, { kind: 'change_schedule_reverted', source: 'system', actorService: 'billing', detail: { reason: 'provider_error' } });
        });
      }
      throw e;
    }
    const row = await withTx(async (tx) => {
      const r = await applySubscription(tx, ws, sub, { provider: provider.name, entry: { kind: kind === 'scheduled' ? 'change_provider_updated' : 'change_applied', source: 'user', actorUserId: ctx.actor.userId } });
      await audit(tx, { workspaceId: ws, actorUserId: ctx.actor.userId, action: kind === 'scheduled' ? 'billing.change_scheduled' : 'billing.change_applied', resourceType: 'workspace_billing', resourceId: ws,
        diff: { from: { plan: b.plan_id, seats: b.seats }, to: { plan: input.plan, seats: input.seats }, kind, test_mode: !provider.livemode }, correlationId: ctx.correlationId });
      return r.row;
    });
    return { ok: true as const, kind, plan_id: row.plan_id, seats: row.seats, scheduled_effective_at: iso(row.scheduled_effective_at) };
  });
}

/** Undo a scheduled downgrade / seat reduction before it takes effect (restores the provider price/quantity). */
export async function cancelScheduledChange(ctx: Ctx) {
  requireAction(ctx, 'billing.manage');
  const ws = ctx.access.workspaceId;
  return withBillingLock(ws, async () => {
    const b = await loadBilling(getPool(), ws);
    if (!b?.scheduled_effective_at || !liveSub(b)) throw new AppError('invalid_state', 'There is no scheduled change.');
    const provider = requireBillingProvider();
    const priceRef = await priceRefFor(getPool(), provider.name, provider.livemode, b.plan_version_id!);
    const sub = await provider.updateSubscription({ subscriptionRef: b.provider_subscription_ref!, itemRef: b.provider_item_ref, priceRef, quantity: b.seats, prorationBehavior: 'none', idempotencyKey: `relay-unschedule-${ws}-${b.version}` });
    await withTx(async (tx) => {
      const prev = await lockBilling(tx, ws);
      await saveBilling(tx, prev, { ...prev, scheduled_plan_version_id: null, scheduled_seats: null, scheduled_effective_at: null }, { kind: 'change_unscheduled', source: 'user', actorUserId: ctx.actor.userId }, ['billing.subscription_changed']);
      await applySubscription(tx, ws, sub, { provider: provider.name, entry: { kind: 'change_unscheduled', source: 'user', actorUserId: ctx.actor.userId } });
      await audit(tx, { workspaceId: ws, actorUserId: ctx.actor.userId, action: 'billing.change_unscheduled', resourceType: 'workspace_billing', resourceId: ws, diff: {}, correlationId: ctx.correlationId });
    });
    return { ok: true as const };
  });
}

// ------------------------------------------------------------------ cancel / reactivate
async function setCancel(ctx: Ctx, cancel: boolean) {
  requireAction(ctx, 'billing.manage');
  const ws = ctx.access.workspaceId;
  return withBillingLock(ws, async () => {
    const b = await loadBilling(getPool(), ws);
    if (!b || !liveSub(b)) throw new AppError('invalid_state', 'There is no subscription to change.');
    if (cancel && b.cancel_at_period_end) throw new AppError('invalid_state', 'Renewal is already cancelled.');
    if (!cancel && !b.cancel_at_period_end) throw new AppError('invalid_state', 'Renewal is not cancelled.');
    const provider = requireBillingProvider();
    const sub = await provider.updateSubscription({ subscriptionRef: b.provider_subscription_ref!, cancelAtPeriodEnd: cancel, idempotencyKey: `relay-${cancel ? 'cancel' : 'resume'}-${ws}-${b.version}` });
    const row = await withTx(async (tx) => {
      const r = await applySubscription(tx, ws, sub, { provider: provider.name, entry: { kind: cancel ? 'cancellation_requested' : 'reactivation_requested', source: 'user', actorUserId: ctx.actor.userId } });
      await audit(tx, { workspaceId: ws, actorUserId: ctx.actor.userId, action: cancel ? 'billing.cancel_scheduled' : 'billing.reactivated', resourceType: 'workspace_billing', resourceId: ws,
        diff: { cancel_at: iso(r.row.cancel_at), test_mode: !provider.livemode }, correlationId: ctx.correlationId });
      return r.row;
    });
    return { ok: true as const, status: row.status, cancel_at: iso(row.cancel_at) };
  });
}
export const cancelRenewal = (ctx: Ctx) => setCancel(ctx, true);
export const reactivateRenewal = (ctx: Ctx) => setCancel(ctx, false);

// ------------------------------------------------------------------ invoices
export async function listInvoices(ctx: Ctx, db: Queryable = getPool()): Promise<{ items: BillingInvoiceDto[] }> {
  requireAction(ctx, 'billing.read');
  const rows = await many<Parameters<typeof invoiceDto>[0]>(db, `SELECT * FROM billing_invoices WHERE workspace_id=$1 ORDER BY provider_created_at DESC LIMIT 50`, [ctx.access.workspaceId]);
  return { items: rows.map(invoiceDto) };
}

export function paidSubscriptionLive(b: BillingRow): boolean { return hasPaidSubscription(b.status, b.provider_subscription_ref) && liveSub(b); }
