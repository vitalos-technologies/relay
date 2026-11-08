// Provider webhook ingestion + processing (brief V4 §10; V5 §8). Order of operations:
//   1. verify `Stripe-Signature` (v1 HMAC, tolerance, rotation) — unverified requests are rejected and never stored;
//   2. store the event (UNIQUE provider + event id → duplicates are acknowledged and not re-processed);
//   3. process: map to a workspace through OUR stored provider references (metadata only as a cross-checked fallback),
//      RE-FETCH the object from the provider and apply it (sync.ts). Out-of-order events converge on current truth.
//   4. failures stay `failed` with backoff; the worker sweep retries (reconcile.ts). The endpoint still answers 200 once
//      the event is stored, so the provider does not hammer us while we own the retry.
import { AppError } from '@social-lite/core';
import { getPool, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { workspaceIdOf } from '@social-lite/providers/stripe/normalize';
import { StripeSignatureError, verifySignature } from '@social-lite/providers/stripe/signature';
import type { BillingProvider, ProviderEvent } from '@social-lite/providers/stripe/types';
import { log } from '../log.js';
import { getBillingProvider } from './provider.js';
import { applyInvoice, applySubscription } from './sync.js';

type Obj = Record<string, unknown>;
const MAX_ATTEMPTS = 10;

export const HANDLED_EVENTS = [
  'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.paused',
  'customer.subscription.resumed', 'customer.subscription.trial_will_end', 'customer.subscription.pending_update_applied',
  'invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.finalized',
  'invoice.voided', 'invoice.marked_uncollectible', 'customer.updated', 'payment_method.attached',
] as const;

export interface IngestResult { received: true; duplicate: boolean; status: 'processed' | 'ignored' | 'failed' | 'received'; event_id: string }

function parseEvent(raw: string): ProviderEvent {
  let e: Obj;
  try { e = JSON.parse(raw) as Obj; } catch { throw new AppError('validation_failed', 'Invalid JSON'); }
  const data = e.data as Obj | undefined;
  if (typeof e.id !== 'string' || !/^evt_[A-Za-z0-9_]{3,100}$/.test(e.id) || typeof e.type !== 'string' || typeof e.created !== 'number' || !data || typeof data.object !== 'object' || !data.object) {
    throw new AppError('validation_failed', 'Not a provider event');
  }
  return { id: e.id, type: e.type, created: e.created, livemode: e.livemode === true, object: data.object as Obj, api_version: typeof e.api_version === 'string' ? e.api_version : null };
}

/** Verify, store and (inline) process one webhook delivery. Throws AppError('unauthenticated') on a bad signature. */
export async function ingestWebhook(raw: string, signatureHeader: string | null, opts: { provider?: 'stripe' | 'test'; db?: Queryable } = {}): Promise<IngestResult> {
  const provider = getBillingProvider();
  if (!provider) throw new AppError('provider_not_configured', 'Billing is not set up');
  if (opts.provider && opts.provider !== provider.name) throw new AppError('unauthenticated', 'Webhook signature verification failed');
  try {
    verifySignature(raw, signatureHeader, provider.webhookSecrets());
  } catch (e) {
    if (e instanceof StripeSignatureError) {
      log.warn('billing_webhook_signature_rejected', { reason: e.reason });
      throw new AppError('unauthenticated', 'Webhook signature verification failed', undefined, { reason: e.reason });
    }
    throw e;
  }
  const evt = parseEvent(raw);
  const db = opts.db ?? getPool();
  const handled = (HANDLED_EVENTS as readonly string[]).includes(evt.type) && evt.livemode === provider.livemode;
  const objectType = typeof evt.object.object === 'string' ? evt.object.object : null;
  const ins = await maybeOne<{ id: string }>(db,
    `INSERT INTO billing_webhook_events(provider, provider_event_id, type, livemode, provider_created_at, object_type, object_ref, status, payload, next_attempt_at, processed_at)
     VALUES ($1,$2,$3,$4,to_timestamp($5),$6,$7,$8,$9, now() + interval '2 minutes', CASE WHEN $8='ignored' THEN now() END)
     ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id::text`,
    [provider.name, evt.id, evt.type, evt.livemode, evt.created, objectType, typeof evt.object.id === 'string' ? evt.object.id : null, handled ? 'received' : 'ignored', raw]);
  if (!ins) return { received: true, duplicate: true, status: 'received', event_id: evt.id };
  if (!handled) return { received: true, duplicate: false, status: 'ignored', event_id: evt.id };
  const status = await processWebhookEvent(ins.id, { provider, db });
  return { received: true, duplicate: false, status, event_id: evt.id };
}

/** Find the workspace an object belongs to: our stored references first; metadata only if it agrees with them. */
async function resolveWorkspace(db: Queryable, provider: 'stripe' | 'test', o: Obj, refs: { customer: string | null; subscription: string | null }): Promise<string | null> {
  if (refs.subscription) {
    const r = await maybeOne<{ workspace_id: string }>(db, `SELECT workspace_id FROM workspace_billing WHERE provider=$1 AND provider_subscription_ref=$2`, [provider, refs.subscription]);
    if (r) return r.workspace_id;
  }
  if (refs.customer) {
    const r = await maybeOne<{ workspace_id: string }>(db, `SELECT workspace_id FROM workspace_billing WHERE provider=$1 AND provider_customer_ref=$2`, [provider, refs.customer]);
    if (r) return r.workspace_id;
  }
  const meta = workspaceIdOf(o);
  if (meta && refs.customer) {
    // Metadata alone is never trusted: the customer must be the one we created for that workspace.
    const r = await maybeOne<{ workspace_id: string }>(db, `SELECT workspace_id FROM workspace_billing WHERE workspace_id=$1 AND provider=$2 AND provider_customer_ref=$3`, [meta, provider, refs.customer]);
    if (r) return r.workspace_id;
  }
  return null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as Obj).id === 'string' ? (v as Obj).id as string : null);

/** Process one stored event (inline after ingest, or by the retry sweep). Never throws. */
export async function processWebhookEvent(eventRowId: string, opts: { provider?: BillingProvider | null; db?: Queryable } = {}): Promise<'processed' | 'ignored' | 'failed'> {
  const db = opts.db ?? getPool();
  const row = await maybeOne<{ provider: 'stripe' | 'test'; provider_event_id: string; type: string; payload: Obj | string; attempts: number }>(db,
    `UPDATE billing_webhook_events SET attempts=attempts+1, next_attempt_at=now() + interval '2 minutes' WHERE id=$1 AND status IN ('received','failed') RETURNING provider, provider_event_id, type, payload, attempts`, [eventRowId]);
  if (!row) return 'processed';
  const provider = opts.provider ?? getBillingProvider();
  try {
    if (!provider || provider.name !== row.provider) throw new Error('provider unavailable');
    const evt = typeof row.payload === 'string' ? JSON.parse(row.payload) as Obj : row.payload;
    const o = (evt.data as Obj).object as Obj;
    const result = await handle(db, provider, row.type, row.provider_event_id, o);
    await db.query(`UPDATE billing_webhook_events SET status=$2, workspace_id=coalesce($3, workspace_id), processed_at=now(), last_error=NULL WHERE id=$1`,
      [eventRowId, result.status, result.workspaceId]);
    return result.status;
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 480) ?? 'error';
    const backoffMin = Math.min(360, 2 ** Math.min(row.attempts, 9));
    await db.query(`UPDATE billing_webhook_events SET status='failed', last_error=$2, next_attempt_at=CASE WHEN attempts >= $3 THEN 'infinity'::timestamptz ELSE now() + make_interval(mins => $4) END WHERE id=$1`,
      [eventRowId, msg, MAX_ATTEMPTS, backoffMin]);
    log.warn('billing_webhook_failed', { eventId: row.provider_event_id, type: row.type, attempts: row.attempts, err: msg });
    return 'failed';
  }
}

async function handle(db: Queryable, provider: BillingProvider, type: string, eventId: string, o: Obj): Promise<{ status: 'processed' | 'ignored'; workspaceId: string | null }> {
  const entry = (kind: string) => ({ kind, source: 'webhook' as const, actorService: `${provider.name}-webhook`, providerEventId: eventId });
  if (type.startsWith('checkout.session.')) {
    const s = await provider.retrieveCheckoutSession(String(o.id));
    if (!s) return { status: 'ignored', workspaceId: null };
    const ws = await resolveWorkspace(db, provider.name, o, { customer: s.customer_ref, subscription: s.subscription_ref });
    if (!ws) return { status: 'ignored', workspaceId: null };
    const sub = s.status === 'complete' && s.subscription_ref ? await provider.retrieveSubscription(s.subscription_ref) : null;
    const pm = sub ? await provider.paymentMethodSummary(sub.customer_ref, sub.ref).catch(() => undefined) : undefined;
    await withTx(async (tx) => {
      await tx.query(
        `UPDATE billing_checkout_sessions SET status=CASE WHEN $3='complete' THEN 'completed' WHEN $3='expired' THEN 'expired' ELSE status END,
                completed_at=CASE WHEN $3='complete' THEN coalesce(completed_at, now()) ELSE completed_at END, provider_subscription_ref=coalesce($4, provider_subscription_ref)
          WHERE provider=$1 AND provider_session_ref=$2 AND workspace_id=$5`, [provider.name, s.ref, s.status, s.subscription_ref, ws]);
      if (sub) await applySubscription(tx, ws, sub, { provider: provider.name, entry: entry('checkout_completed'), paymentMethod: pm ?? undefined });
    });
    return { status: 'processed', workspaceId: ws };
  }
  if (type.startsWith('customer.subscription.')) {
    const sub = await provider.retrieveSubscription(String(o.id));
    if (!sub) return { status: 'ignored', workspaceId: null };
    const ws = await resolveWorkspace(db, provider.name, o, { customer: sub.customer_ref, subscription: sub.ref });
    if (!ws) return { status: 'ignored', workspaceId: null };
    await withTx((tx) => applySubscription(tx, ws, sub, { provider: provider.name, entry: entry(type.replace('customer.subscription.', 'subscription_')) }));
    return { status: 'processed', workspaceId: ws };
  }
  if (type.startsWith('invoice.')) {
    const inv = await provider.retrieveInvoice(String(o.id));
    if (!inv) return { status: 'ignored', workspaceId: null };
    const ws = await resolveWorkspace(db, provider.name, o, { customer: inv.customer_ref, subscription: inv.subscription_ref });
    if (!ws) return { status: 'ignored', workspaceId: null };
    const sub = inv.subscription_ref ? await provider.retrieveSubscription(inv.subscription_ref) : null;
    await withTx(async (tx) => {
      await applyInvoice(tx, ws, inv, { provider: provider.name, eventType: type });
      if (sub) await applySubscription(tx, ws, sub, { provider: provider.name, entry: entry(type.replace('.', '_')) });
    });
    return { status: 'processed', workspaceId: ws };
  }
  if (type === 'customer.updated' || type === 'payment_method.attached') {
    const customer = type === 'customer.updated' ? String(o.id) : str(o.customer);
    if (!customer) return { status: 'ignored', workspaceId: null };
    const ws = await resolveWorkspace(db, provider.name, o, { customer, subscription: null });
    if (!ws) return { status: 'ignored', workspaceId: null };
    const b = await maybeOne<{ provider_subscription_ref: string | null }>(db, `SELECT provider_subscription_ref FROM workspace_billing WHERE workspace_id=$1`, [ws]);
    const pm = await provider.paymentMethodSummary(customer, b?.provider_subscription_ref ?? null);
    await db.query(`UPDATE workspace_billing SET payment_method=$2, updated_at=now() WHERE workspace_id=$1`, [ws, pm ? JSON.stringify(pm) : null]);
    return { status: 'processed', workspaceId: ws };
  }
  return { status: 'ignored', workspaceId: null };
}

/** Retry stored events whose processing failed or never ran (worker sweep). */
export async function retryPendingWebhooks(limit = 25, db: Queryable = getPool()): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `SELECT id::text FROM billing_webhook_events WHERE status IN ('received','failed') AND next_attempt_at <= now() ORDER BY id LIMIT $1`, [limit]);
  for (const r of rows.rows) await processWebhookEvent(r.id, { db });
  return rows.rowCount ?? 0;
}
