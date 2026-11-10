// Held work (V4 §13). When the plan or billing state no longer allows a paid action, queued work is HELD with a visible
// reason — never dropped, deleted, duplicated or silently published — and released when access returns:
//   - scheduled posts:   deliveries state 'blocked' + last_error_code 'entitlement_hold' (same mechanics as brand-rule /
//                        authority holds). Only not-yet-started deliveries are touched; preparing/publishing/processing/
//                        unknown/handoff keep their in-flight + reconciliation rules. A hold past its publish-before
//                        deadline becomes 'expired' (Missed) through the existing deadline sweep — never published late.
//   - queued replies:    stay 'queued' with error_code 'entitlement_hold' and a later next_attempt_at (re-checked each time).
//   - sync jobs:         stay 'queued'/'waiting_retry' with last_error_code 'entitlement_hold'.
//   - listening:         new items are still observed (data kept) but not matched to saved searches; on restore the
//                        searches are re-matched over the stored observations.
//   D33 (Free plan) adds three reasons a scheduled post is held (same 'entitlement_hold' mechanics): its brand is over the
//   brand limit, its account is over the account limit, or its publication month has no scheduled-post allowance left
//   (posts are counted once per post per month; the earliest-due posts use the allowance first). Members over the user
//   limit lose product access (tenancy.ts loadAccess), never their account.
// Release triggers: billing.access_changed (outbox → worker), override changes, selection changes, and a worker sweep
// (safety net for a missed event). The dispatch-time gate is authoritative either way.
import { ENTITLEMENT_HOLD } from '@social-lite/core/contracts/v4-entitlements';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { log } from '../log.js';
import { checkFeature, entitlementsCore, invalidateEntitlements, type EntitlementsCore } from './resolve.js';
import { brandHeld, connectionHeld, heldIds } from './gauges.js';
import { chargeScheduledPost } from './actions.js';

export const HOLD_RECHECK_MINUTES = 15;
/** automation_runs.reason prefix for runs blocked by the plan/billing state (counted on the usage page). */
export const AUTOMATION_HOLD_PREFIX = 'Held by plan: ';

export type HoldDecision = { held: false } | { held: true; message: string };

const brandHoldMessage = (limit: number | null) => `Held: this brand is over the plan’s limit of ${limit} brand${limit === 1 ? '' : 's'}. Upgrade, or choose which brand stays active in Usage.`;
const postHoldMessage = (m: string) => `Held: ${m} It publishes if an allowance frees up in time (or after an upgrade).`;

/**
 * Publishing gate for one delivery (engine/process.ts gate: once before the send transaction, again inside it). With the
 * delivery's post/brand/due time it also applies the D33 brand and scheduled-post limits (the post is counted once for
 * its month — idempotent, so both gate runs and the scheduling-time count are the same unit).
 */
export async function publishingHold(db: Queryable, workspaceId: string, connectionId: string, d?: { brandId: string; postId: string; dueAt: Date }): Promise<HoldDecision> {
  const core = await entitlementsCore(db, workspaceId);
  // A staff suspension is already enforced by the engine (paused, resumed on reactivation); nothing to add here.
  if (core.access === 'suspended') return { held: false };
  const c = checkFeature(core, 'publishing', { paid: true });
  if (!c.ok) return { held: true, message: `Held: ${c.message} It publishes when access returns, if still timely.` };
  const h = await connectionHeld(db, workspaceId, connectionId, core);
  if (h.held) return { held: true, message: `Held: this account is over the plan’s limit of ${h.limit} connected accounts. Choose which accounts stay active in Usage.` };
  if (d) {
    const b = await brandHeld(db, workspaceId, d.brandId, core);
    if (b.held) return { held: true, message: brandHoldMessage(b.limit) };
    if (core.limits.scheduled_posts.limit !== null) {
      // Counter locks need a transaction: the pre-send check runs on the pool, so give it its own.
      const charge = (tx: Queryable) => chargeScheduledPost(tx, workspaceId, { postId: d.postId, dueAt: d.dueAt, userId: null, core });
      const r = db === getPool() ? await withTx(charge) : await charge(db);
      if (!r.ok) return { held: true, message: postHoldMessage(r.message) };
    }
  }
  return { held: false };
}

/** Queued social-inbox reply gate (inbox/replies.ts dispatch). */
export async function replyHold(db: Queryable, workspaceId: string): Promise<HoldDecision> {
  const core = await entitlementsCore(db, workspaceId);
  const c = checkFeature(core, 'inbox', { paid: true });
  return c.ok ? { held: false } : { held: true, message: `Held: ${c.message} Nothing was sent; it sends when access returns, if the network still allows it.` };
}

/** Business-integration sync gate (connectors/jobs.ts). */
export async function syncHold(db: Queryable, workspaceId: string): Promise<HoldDecision> {
  const core = await entitlementsCore(db, workspaceId);
  const c = checkFeature(core, 'integrations_business', { paid: true });
  return c.ok ? { held: false } : { held: true, message: `Held: ${c.message} Nothing was sent.` };
}

/** Saved searches that may match new items now (listening ingest). Empty when listening is not available. */
export async function matchableSearchFilter(db: Queryable, workspaceId: string): Promise<(searchId: string) => boolean> {
  const core = await entitlementsCore(db, workspaceId);
  if (!checkFeature(core, 'listening', { paid: true }).ok) return () => false;
  const held = await heldIds(db, workspaceId, 'listening_searches', core);
  return (id) => !held.has(id);
}

export interface ReevaluateResult {
  access: EntitlementsCore['access'];
  changed: boolean;
  released: { deliveries: number; expired: number; replies: number; sync_jobs: number; searches_rematched: number };
  held: { deliveries: number; replies: number; sync_jobs: number };
}

/**
 * Re-evaluate one workspace: release holds that no longer apply, mark newly affected waiting work, record the access
 * transition (workspace audit). Idempotent; safe to run from the event handler, the sweep and request paths.
 */
export async function reevaluateHolds(workspaceId: string, opts: { reason?: string; db?: Queryable } = {}): Promise<ReevaluateResult> {
  const run = async (tx: Queryable): Promise<ReevaluateResult> => {
    invalidateEntitlements(workspaceId);
    const core = await entitlementsCore(tx, workspaceId);
    const out: ReevaluateResult = { access: core.access, changed: false, released: { deliveries: 0, expired: 0, replies: 0, sync_jobs: 0, searches_rematched: 0 }, held: { deliveries: 0, replies: 0, sync_jobs: 0 } };
    const prev = await maybeOne<{ access: string; reason: string | null }>(tx, `SELECT access, reason FROM workspace_entitlement_state WHERE workspace_id=$1 FOR UPDATE`, [workspaceId]);
    out.changed = !!prev && prev.access !== core.access;

    if (core.access !== 'suspended') {
      // ---- scheduled posts
      const pub = checkFeature(core, 'publishing', { paid: true });
      const heldConns = pub.ok ? [...await heldIds(tx, workspaceId, 'social_accounts', core)] : [];
      const heldBrands = pub.ok ? [...await heldIds(tx, workspaceId, 'brands', core)] : [];
      // D33 scheduled-post allowance: waiting posts (earliest due first) are counted for their month until it is full;
      // the rest are held. Already-counted posts are free (ledger dedupe), so this is idempotent.
      const heldPosts: string[] = [];
      let postMsg = '';
      if (pub.ok && core.limits.scheduled_posts.limit !== null) {
        const waiting = await many<{ post_id: string; due_at: Date }>(tx,
          `SELECT post_id, min(due_at) due_at FROM deliveries
            WHERE workspace_id=$1 AND (state IN ('scheduled','retry_wait') AND lease_owner IS NULL OR (state='blocked' AND last_error_code=$2))
              AND publish_before > now() AND NOT (connection_id = ANY($3::uuid[])) AND NOT (brand_id = ANY($4::uuid[]))
            GROUP BY post_id ORDER BY min(due_at), post_id LIMIT 500`, [workspaceId, ENTITLEMENT_HOLD, heldConns, heldBrands]);
        for (const w of waiting) {
          const r = await chargeScheduledPost(tx, workspaceId, { postId: w.post_id, dueAt: w.due_at, userId: null, core });
          if (!r.ok) { heldPosts.push(w.post_id); postMsg = postHoldMessage(r.message); }
        }
      }
      if (pub.ok) {
        const exp = await tx.query(
          `UPDATE deliveries SET state='expired', last_error_code='deadline_passed',
                  last_error_message='The publish-before deadline passed while this was held by the plan. Reschedule if still relevant.', updated_at=now()
            WHERE workspace_id=$1 AND state='blocked' AND last_error_code=$2 AND publish_before <= now() RETURNING id`, [workspaceId, ENTITLEMENT_HOLD]);
        out.released.expired = exp.rowCount ?? 0;
        for (const r of exp.rows as Array<{ id: string }>) await writeOutbox(tx, { workspaceId, aggregateType: 'delivery', aggregateId: r.id, eventType: 'delivery.state_changed', payload: { state: 'expired' } });
        const rel = await tx.query<{ id: string }>(
          `UPDATE deliveries SET state='scheduled', blocked_reason=NULL, last_error_code=NULL, last_error_message=NULL, next_attempt_at=greatest(next_attempt_at, now()), updated_at=now()
            WHERE workspace_id=$1 AND state='blocked' AND last_error_code=$2 AND publish_before > now() AND NOT (connection_id = ANY($3::uuid[]))
              AND NOT (brand_id = ANY($4::uuid[])) AND NOT (post_id = ANY($5::uuid[])) RETURNING id`,
          [workspaceId, ENTITLEMENT_HOLD, heldConns, heldBrands, heldPosts]);
        out.released.deliveries = rel.rowCount ?? 0;
        for (const r of rel.rows) await writeOutbox(tx, { workspaceId, aggregateType: 'delivery', aggregateId: r.id, eventType: 'delivery.due' });
      }
      // One pass per reason (the first matching reason wins: plan/access, then account, then brand, then allowance).
      const passes: Array<{ msg: string; all: boolean; conns: string[]; brands: string[]; posts: string[] }> = !pub.ok
        ? [{ msg: `Held: ${pub.message} It publishes when access returns, if still timely.`, all: true, conns: [], brands: [], posts: [] }]
        : [
          { msg: 'Held: this account is over the plan’s limit of connected accounts. Choose which accounts stay active in Usage.', all: false, conns: heldConns, brands: [], posts: [] },
          { msg: brandHoldMessage(core.limits.brands.limit), all: false, conns: [], brands: heldBrands, posts: [] },
          { msg: postMsg, all: false, conns: [], brands: [], posts: heldPosts },
        ].filter((x) => x.conns.length || x.brands.length || x.posts.length);
      const already = new Set<string>();
      for (const ps of passes) {
        const h = await tx.query<{ id: string }>(
          `UPDATE deliveries SET state='blocked', blocked_reason=$2, last_error_code=$3, last_error_message=$2, updated_at=now()
            WHERE workspace_id=$1 AND state IN ('scheduled','retry_wait') AND lease_owner IS NULL
              AND ($4::boolean OR connection_id = ANY($5::uuid[]) OR brand_id = ANY($6::uuid[]) OR post_id = ANY($7::uuid[])) RETURNING id`,
          [workspaceId, ps.msg.slice(0, 500), ENTITLEMENT_HOLD, ps.all, ps.conns, ps.brands, ps.posts]);
        out.held.deliveries += h.rowCount ?? 0;
        for (const r of h.rows) await writeOutbox(tx, { workspaceId, aggregateType: 'delivery', aggregateId: r.id, eventType: 'delivery.state_changed', payload: { state: 'blocked' } });
        // Keep the visible reason current on deliveries that stay held for a different reason now.
        const upd = await tx.query<{ id: string }>(`UPDATE deliveries SET blocked_reason=$2, last_error_message=$2 WHERE workspace_id=$1 AND state='blocked' AND last_error_code=$3
            AND ($4::boolean OR connection_id = ANY($5::uuid[]) OR brand_id = ANY($6::uuid[]) OR post_id = ANY($7::uuid[])) AND NOT (id = ANY($8::uuid[])) AND blocked_reason IS DISTINCT FROM $2 RETURNING id`,
          [workspaceId, ps.msg.slice(0, 500), ENTITLEMENT_HOLD, ps.all, ps.conns, ps.brands, ps.posts, [...already]]);
        for (const r of [...h.rows, ...upd.rows]) already.add(r.id);
      }

      // ---- queued replies
      const inbox = checkFeature(core, 'inbox', { paid: true });
      if (inbox.ok) {
        const r = await tx.query<{ id: string; conversation_id: string }>(
          `UPDATE inbox_reply_attempts SET next_attempt_at=now(), error_code=NULL, error_message=NULL, updated_at=now()
            WHERE workspace_id=$1 AND state='queued' AND error_code=$2 RETURNING id, conversation_id`, [workspaceId, ENTITLEMENT_HOLD]);
        out.released.replies = r.rowCount ?? 0;
        for (const a of r.rows) await writeOutbox(tx, { workspaceId, aggregateType: 'inbox_reply_attempt', aggregateId: a.id, eventType: 'inbox.reply_requested', payload: { conversationId: a.conversation_id } });
      } else {
        const r = await tx.query(
          `UPDATE inbox_reply_attempts SET error_code=$2, error_message=$3, next_attempt_at=greatest(next_attempt_at, now() + make_interval(mins => $4)), updated_at=now()
            WHERE workspace_id=$1 AND state='queued' AND coalesce(error_code, '') <> $2`,
          [workspaceId, ENTITLEMENT_HOLD, `Held: ${inbox.message}`.slice(0, 300), HOLD_RECHECK_MINUTES]);
        out.held.replies = r.rowCount ?? 0;
      }

      // ---- business-integration sync jobs
      const sync = checkFeature(core, 'integrations_business', { paid: true });
      if (sync.ok) {
        const r = await tx.query<{ id: string; kind: string }>(
          `UPDATE integration_sync_jobs SET next_attempt_at=now(), last_error_code=NULL, last_error=NULL, updated_at=now()
            WHERE workspace_id=$1 AND state IN ('queued','waiting_retry') AND last_error_code=$2 RETURNING id, kind`, [workspaceId, ENTITLEMENT_HOLD]);
        out.released.sync_jobs = r.rowCount ?? 0;
        for (const j of r.rows) await writeOutbox(tx, { workspaceId, aggregateType: 'integration_sync_job', aggregateId: j.id, eventType: 'integration.sync_requested', payload: { kind: j.kind } });
      } else {
        const r = await tx.query(
          `UPDATE integration_sync_jobs SET last_error_code=$2, last_error=$3, next_attempt_at=greatest(next_attempt_at, now() + make_interval(mins => $4)), updated_at=now()
            WHERE workspace_id=$1 AND state IN ('queued','waiting_retry') AND coalesce(last_error_code, '') <> $2`,
          [workspaceId, ENTITLEMENT_HOLD, `Held: ${sync.message}`.slice(0, 300), HOLD_RECHECK_MINUTES]);
        out.held.sync_jobs = r.rowCount ?? 0;
      }

      // ---- listening: access came back ⇒ re-match stored observations for searches that may match again
      if (out.changed && core.access === 'full' && checkFeature(core, 'listening', { paid: true }).ok) {
        const held = [...await heldIds(tx, workspaceId, 'listening_searches', core)];
        const r = await tx.query(`UPDATE listening_searches SET rematch_state='pending', updated_at=now() WHERE workspace_id=$1 AND archived_at IS NULL AND NOT (id = ANY($2::uuid[]))`, [workspaceId, held]);
        out.released.searches_rematched = r.rowCount ?? 0;
      }
    }

    await tx.query(
      `INSERT INTO workspace_entitlement_state(workspace_id, plan_id, access, reason, evaluated_at, changed_at) VALUES ($1,$2,$3,$4,now(),now())
       ON CONFLICT (workspace_id) DO UPDATE SET plan_id=EXCLUDED.plan_id, access=EXCLUDED.access, reason=EXCLUDED.reason, evaluated_at=now(),
         changed_at=CASE WHEN workspace_entitlement_state.access IS DISTINCT FROM EXCLUDED.access THEN now() ELSE workspace_entitlement_state.changed_at END`,
      [workspaceId, core.plan?.id ?? null, core.access, core.accessReason]);
    const moved = out.released.deliveries + out.released.expired + out.released.replies + out.released.sync_jobs + out.held.deliveries + out.held.replies + out.held.sync_jobs;
    if (out.changed || moved) {
      await audit(tx, { workspaceId, actorService: 'entitlements', action: 'entitlements.reevaluated', resourceType: 'workspace', resourceId: workspaceId,
        diff: { access: core.access, previous: prev?.access ?? null, reason: opts.reason ?? null, released: out.released, held: out.held } });
    }
    return out;
  };
  return opts.db ? run(opts.db) : withTx(run);
}

/** Outbox consumer for BIL's `billing.access_changed` (and other billing events that may change entitlements). */
export async function onBillingAccessChanged(evt: { workspace_id: string | null; event_type: string }): Promise<void> {
  if (!evt.workspace_id) return;
  const r = await reevaluateHolds(evt.workspace_id, { reason: evt.event_type });
  log.info('entitlements_reevaluated', { workspaceId: evt.workspace_id, event: evt.event_type, access: r.access, changed: r.changed });
}

/**
 * Worker sweep (safety net): re-evaluate workspaces that hold work or were last seen without full access. Bounded.
 * A missed event can therefore only delay a release, never lose held work.
 */
export async function sweepEntitlementHolds(limit = 50): Promise<number> {
  const db = getPool();
  const rows = await many<{ workspace_id: string }>(db,
    `SELECT x.workspace_id FROM (
        SELECT workspace_id FROM workspace_entitlement_state WHERE access <> 'full'
        UNION SELECT workspace_id FROM deliveries WHERE state='blocked' AND last_error_code=$1
        UNION SELECT workspace_id FROM inbox_reply_attempts WHERE state='queued' AND error_code=$1
        UNION SELECT workspace_id FROM integration_sync_jobs WHERE state IN ('queued','waiting_retry') AND last_error_code=$1
      ) x LEFT JOIN workspace_entitlement_state s USING (workspace_id)
      ORDER BY s.evaluated_at NULLS FIRST LIMIT $2`, [ENTITLEMENT_HOLD, limit]);
  let n = 0;
  for (const r of rows) {
    try { await reevaluateHolds(r.workspace_id, { reason: 'sweep' }); n++; } catch (err) { log.warn('entitlements_sweep_failed', { workspaceId: r.workspace_id, err: err as Error }); }
  }
  return n;
}

/** Automation rule runs (automation/engine.ts): blocked runs are recorded with this reason (visible in the run log). */
export async function automationHold(db: Queryable, workspaceId: string): Promise<HoldDecision> {
  const core = await entitlementsCore(db, workspaceId);
  const c = checkFeature(core, 'automation', { paid: true });
  return c.ok ? { held: false } : { held: true, message: `${AUTOMATION_HOLD_PREFIX}${c.message}`.slice(0, 300) };
}
