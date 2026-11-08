// V3: provider-native scheduling owner (YouTube publishAt). Relay's schedule stays the single source of truth:
// the delivery is dispatched EARLY (upload + processing need time) and the provider is told to release it at the
// schedule's due time. If too little lead time remains, the delivery falls back to app-owned publication at the
// due time — recorded explicitly, never silently, and never published early.
import type { Queryable } from '@social-lite/db';
import { writeOutbox } from '../outbox.js';

/** How long before the due time a provider-held upload is dispatched. */
export const EARLY_UPLOAD_MINUTES = Math.max(15, Number(process.env.PROVIDER_EARLY_UPLOAD_MINUTES ?? 180) || 180);
/** Minimum lead time for a provider-held release; below this the app publishes at the due time instead. */
export const MIN_PROVIDER_LEAD_MS = 15 * 60_000;

/** Called inside the scheduling transaction after deliveries are inserted. */
export async function applyProviderSchedulingOwner(tx: Queryable, scheduleId: string): Promise<number> {
  const r = await tx.query<{ id: string; workspace_id: string; next_attempt_at: Date }>(
    `UPDATE deliveries d SET scheduling_owner='provider',
            next_attempt_at = greatest(now(), d.due_at - ($2 || ' minutes')::interval), updated_at=now()
       FROM variants v
      WHERE d.variant_id=v.id AND d.schedule_id=$1 AND d.provider='youtube'
        AND v.options->'youtube'->>'schedulingOwner' = 'provider'
      RETURNING d.id, d.workspace_id, d.next_attempt_at`, [scheduleId, String(EARLY_UPLOAD_MINUTES)]);
  for (const row of r.rows) {
    await writeOutbox(tx, { workspaceId: row.workspace_id, aggregateType: 'delivery', aggregateId: row.id, eventType: 'delivery.due', availableAt: row.next_attempt_at });
  }
  return r.rowCount ?? 0;
}

/** Options the adapter receives: publishAt always equals the schedule's due time in provider mode. */
export function providerScheduledOptions(options: Record<string, unknown>, owner: string | null | undefined, dueAt: Date): Record<string, unknown> {
  const yt = (options.youtube ?? null) as Record<string, unknown> | null;
  if (!yt) return options;
  if (owner === 'provider') return { ...options, youtube: { ...yt, schedulingOwner: 'provider', publishAt: dueAt.toISOString() } };
  if (yt.schedulingOwner === 'provider') return { ...options, youtube: { ...yt, schedulingOwner: 'app', publishAt: undefined } };
  return options;
}
