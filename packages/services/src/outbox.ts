// Transactional outbox writer. Call inside the same transaction as the state change.
import type { Queryable } from '@social-lite/db';

export type OutboxEventType =
  | 'delivery.due'              // wake the worker for a specific delivery (fast path)
  | 'delivery.state_changed'    // notifications / history
  | 'schedule.created' | 'schedule.cancelled'
  | 'approval.requested' | 'approval.decided'
  | 'connection.health_changed'
  | 'asset.uploaded'             // run validation/derivatives
  | 'invitation.created'        // send invite email
  | 'webhook.received'
  | 'tipsignal.event_received'
  | 'notification.created'      // email delivery for critical notifications
  | 'comment.created' | 'assignment.changed' | 'review.shared'  // V2 collaboration (collab/**)
  // V3 Content Hub (content-hub/jobs.ts → queues source-import / report-export / writeback)
  | 'source.import_requested' | 'source.changes_signal' | 'export.requested' | 'writeback.requested';

export async function writeOutbox(
  db: Queryable,
  e: { workspaceId: string | null; aggregateType: string; aggregateId: string; eventType: OutboxEventType; payload?: Record<string, unknown>; availableAt?: Date },
): Promise<void> {
  await db.query(
    `INSERT INTO outbox(workspace_id, aggregate_type, aggregate_id, event_type, payload, available_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [e.workspaceId, e.aggregateType, e.aggregateId, e.eventType, JSON.stringify(e.payload ?? {}), e.availableAt ?? new Date()],
  );
}
