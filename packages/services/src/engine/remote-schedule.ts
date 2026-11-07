// V3 provider-native scheduling (spec §7): one scheduling owner per delivery. When the provider holds the
// release (YouTube publishAt), the adapter's processing checkpoint carries `data.remoteSchedule`; the engine
// records scheduling_owner='provider' + remote_schedule, keeps polling until the release (no 2 h timeout), and an
// emergency pause attempts remote cancellation through adapter.cancelRemoteSchedule. If cancellation cannot be
// confirmed the residual risk is reported on the delivery — pause never claims a guarantee it cannot give.
import type { Pool, Queryable } from '@social-lite/db';
import type { RemoteScheduleCancelOutcome } from '@social-lite/core';
import type { ClaimedDelivery } from './claim.js';
import type { EngineDeps } from './process.js';

export interface RemoteSchedule { provider: string; publishAt: string; videoId?: string | null }

export function remoteScheduleOf(prep: ClaimedDelivery['preparation'] | null | undefined): RemoteSchedule | null {
  const rs = (prep?.data as { remoteSchedule?: unknown } | undefined)?.remoteSchedule as Partial<RemoteSchedule> | undefined;
  return rs && typeof rs.publishAt === 'string' && typeof rs.provider === 'string' ? (rs as RemoteSchedule) : null;
}

/** True while the provider still holds a future release (the processing timeout must not apply). */
export const releasePending = (rs: RemoteSchedule | null, nowMs = Date.now()): boolean => !!rs && Date.parse(rs.publishAt) > nowMs;

export async function recordRemoteSchedule(db: Queryable, deliveryId: string, value: Record<string, unknown>): Promise<void> {
  await db.query(`UPDATE deliveries SET scheduling_owner='provider', remote_schedule=$2::jsonb, updated_at=now() WHERE id=$1`, [deliveryId, JSON.stringify(value)]);
}

/** First sighting of a provider-held release: mark the owner (idempotent; keeps later cancellation state). */
export async function ensureRemoteSchedule(db: Queryable, deliveryId: string, rs: RemoteSchedule): Promise<void> {
  await db.query(`UPDATE deliveries SET scheduling_owner='provider', remote_schedule=$2::jsonb WHERE id=$1 AND remote_schedule IS NULL`,
    [deliveryId, JSON.stringify({ ...rs, state: 'scheduled' })]);
}

export async function scopePaused(db: Queryable, d: Pick<ClaimedDelivery, 'id'>): Promise<boolean> {
  const r = await db.query<{ paused: boolean }>(
    `SELECT (w.publishing_paused OR b.publishing_paused OR c.paused) AS paused
       FROM deliveries x JOIN workspaces w ON w.id=x.workspace_id JOIN brands b ON b.id=x.brand_id JOIN connections c ON c.id=x.connection_id
      WHERE x.id=$1`, [d.id]);
  return r.rows[0]?.paused === true;
}

/** Ask the adapter to cancel the provider-held release. Never throws: failures are 'uncertain'. */
export async function cancelRemoteRelease(deps: EngineDeps, d: ClaimedDelivery, rs: RemoteSchedule): Promise<RemoteScheduleCancelOutcome> {
  const adapter = deps.adapterFor(d.provider);
  if (!adapter.cancelRemoteSchedule) return { kind: 'unsupported', message: `Social Lite cannot cancel this ${d.provider} scheduled release; cancel it on the platform before ${rs.publishAt}.` };
  try {
    const creds = await deps.getCredentials(d.connection_id);
    const actx = await deps.adapterContext(d.provider, creds.connection);
    return await adapter.cancelRemoteSchedule(actx, {
      deliveryId: d.id, connection: creds.connection, credentials: creds.credentials, variantText: '', providerIds: d.provider_ids,
      checkpoint: d.preparation, sentAt: null,
    });
  } catch (err) {
    return { kind: 'uncertain', scheduledFor: rs.publishAt, message: `Could not cancel the scheduled release (${(err as Error).message?.slice(0, 120) ?? 'error'}). It may still be published at ${rs.publishAt}; cancel it on the platform.` };
  }
}

/**
 * Pause handling for a provider-held release. Returns the cancellation outcome when the delivery's scope is
 * paused, or null when not paused (normal polling continues).
 */
export async function onPausedRemoteSchedule(deps: EngineDeps, d: ClaimedDelivery, pool: Pool, rs: RemoteSchedule): Promise<RemoteScheduleCancelOutcome | null> {
  if (!(await scopePaused(pool, d))) return null;
  const out = await cancelRemoteRelease(deps, d, rs);
  await recordRemoteSchedule(pool, d.id, { ...rs, state: out.kind, message: out.message, checked_at: new Date().toISOString() });
  return out;
}
