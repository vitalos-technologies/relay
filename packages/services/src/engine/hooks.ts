// Engine hooks called by other services INSIDE their transaction when scope state changes.
// They only touch deliveries that have not begun sending.
import type { Queryable } from '@social-lite/db';
import { writeOutbox } from '../outbox.js';

const NOT_STARTED = `('scheduled','retry_wait','paused','blocked')`;

/**
 * Pause is enforced at dispatch time (SC-05): the worker checks pause flags on every claim.
 * This hook additionally marks waiting deliveries as Paused so the UI shows it immediately.
 */
export async function onScopePaused(db: Queryable, scope: { workspaceId: string; brandId?: string; connectionId?: string }): Promise<number> {
  const r = await db.query(
    `UPDATE deliveries SET state='paused', updated_at=now()
      WHERE workspace_id=$1 AND state IN ('scheduled','retry_wait')
        AND ($2::uuid IS NULL OR brand_id=$2) AND ($3::uuid IS NULL OR connection_id=$3)`,
    [scope.workspaceId, scope.brandId ?? null, scope.connectionId ?? null]);
  // V3: provider-held releases (scheduling_owner='provider', e.g. YouTube publishAt) are already at the provider;
  // poll them now so the worker attempts remote cancellation (engine/remote-schedule.ts) and reports residual risk.
  const held = await db.query<{ id: string }>(
    `UPDATE deliveries SET next_attempt_at=now(), updated_at=now()
      WHERE workspace_id=$1 AND state='processing' AND (scheduling_owner='provider' OR preparation->'data' ? 'remoteSchedule')
        AND ($2::uuid IS NULL OR brand_id=$2) AND ($3::uuid IS NULL OR connection_id=$3)
      RETURNING id`,
    [scope.workspaceId, scope.brandId ?? null, scope.connectionId ?? null]);
  for (const row of held.rows) {
    await writeOutbox(db, { workspaceId: scope.workspaceId, aggregateType: 'delivery', aggregateId: row.id, eventType: 'delivery.due' });
  }
  return r.rowCount ?? 0;
}

/**
 * Resume: Paused -> Scheduled only while still timely; otherwise Expired (never flood a channel
 * with stale posts, SC-07). Deliveries still covered by another active pause stay paused.
 */
export async function onScopeResumed(db: Queryable, scope: { workspaceId: string; brandId?: string; connectionId?: string }): Promise<{ resumed: number; expired: number }> {
  const expired = await db.query(
    `UPDATE deliveries d SET state='expired', last_error_code='deadline_passed',
            last_error_message='The publish-before deadline passed while publishing was paused. Reschedule if still relevant.', updated_at=now()
      WHERE d.workspace_id=$1 AND d.state='paused' AND d.publish_before <= now()
        AND ($2::uuid IS NULL OR d.brand_id=$2) AND ($3::uuid IS NULL OR d.connection_id=$3)`,
    [scope.workspaceId, scope.brandId ?? null, scope.connectionId ?? null]);
  const resumed = await db.query(
    `UPDATE deliveries d SET state='scheduled', next_attempt_at=greatest(d.next_attempt_at, now()), updated_at=now()
       FROM workspaces w, brands b, connections c
      WHERE d.workspace_id=$1 AND d.state='paused'
        AND ($2::uuid IS NULL OR d.brand_id=$2) AND ($3::uuid IS NULL OR d.connection_id=$3)
        AND w.id=d.workspace_id AND NOT w.publishing_paused
        AND b.id=d.brand_id AND NOT b.publishing_paused
        AND c.id=d.connection_id AND NOT c.paused
      RETURNING d.id`,
    [scope.workspaceId, scope.brandId ?? null, scope.connectionId ?? null]);
  for (const row of resumed.rows as Array<{ id: string }>) {
    await writeOutbox(db, { workspaceId: scope.workspaceId, aggregateType: 'delivery', aggregateId: row.id, eventType: 'delivery.due' });
  }
  return { resumed: resumed.rowCount ?? 0, expired: expired.rowCount ?? 0 };
}

/** AC-05: disconnect / lost permission blocks queued work for that connection. */
export async function blockDeliveriesForConnection(db: Queryable, connectionId: string, reason: string): Promise<number> {
  const r = await db.query(
    `UPDATE deliveries SET state='blocked', blocked_reason=$2, updated_at=now()
      WHERE connection_id=$1 AND state IN ${NOT_STARTED} AND state <> 'blocked'`, [connectionId, reason]);
  return r.rowCount ?? 0;
}

/**
 * Connection restored to Ready (reconnect of the SAME provider identity): blocked deliveries
 * are revalidated by the worker on claim; here they return to Scheduled if still timely.
 */
export async function onConnectionRestored(db: Queryable, connectionId: string): Promise<{ restored: number; expired: number }> {
  const expired = await db.query(
    `UPDATE deliveries SET state='expired', last_error_code='deadline_passed',
            last_error_message='The publish-before deadline passed while the account needed attention. Reschedule if still relevant.', updated_at=now()
      WHERE connection_id=$1 AND state='blocked' AND publish_before <= now()`, [connectionId]);
  const restored = await db.query(
    `UPDATE deliveries SET state='scheduled', blocked_reason=NULL, next_attempt_at=greatest(next_attempt_at, now()), updated_at=now()
      WHERE connection_id=$1 AND state='blocked' AND coalesce(last_error_code, '') <> 'authority_hold' RETURNING id, workspace_id`, [connectionId]);
  // (authority_hold: released only by adoption — engine/authority.ts — never by a reconnect)
  for (const row of restored.rows as Array<{ id: string; workspace_id: string }>) {
    await writeOutbox(db, { workspaceId: row.workspace_id, aggregateType: 'delivery', aggregateId: row.id, eventType: 'delivery.due' });
  }
  return { restored: restored.rowCount ?? 0, expired: expired.rowCount ?? 0 };
}
