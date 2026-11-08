// Transactional outbox writer. Call inside the same transaction as the state change.
import type { Queryable } from '@social-lite/db';
import type { V35OutboxEvent } from '@social-lite/core/contracts/v35-events';
import type { BillingEvent } from '@social-lite/core/contracts/v4-billing';
import { currentOrigin } from './automation/origin.js';

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
  | 'comment.edited' | 'task.changed' | 'approval.invalidated' | 'review.reviewers_requested'  // collaboration completion (collab/**)
  // V3 Content Hub (content-hub/jobs.ts → queues source-import / report-export / writeback)
  | 'source.import_requested' | 'source.changes_signal' | 'export.requested' | 'writeback.requested'
  | 'bulk.requested'             // V3.1 bulk jobs (data/bulk.ts → queue bulk-ops)
  // V4 Relay support (support/notify.ts → durable customer + staff notifications)
  | 'support.ticket_created' | 'support.message_created' | 'support.ticket_assigned' | 'support.access_requested' | 'support.access_decided'
  | 'support.widget_verification' // V5 WID: one-time code/link email for a widget visitor (support/widget-verify.ts)
  | V35OutboxEvent              // V3.5 inbox / care / integrations (contracts/v35-events.ts)
  | BillingEvent;               // V4 billing (BIL; contracts/v4-billing.ts BILLING_EVENTS → events queue)

export async function writeOutbox(
  db: Queryable,
  e: { workspaceId: string | null; aggregateType: string; aggregateId: string; eventType: OutboxEventType; payload?: Record<string, unknown>; availableAt?: Date },
): Promise<void> {
  await db.query(
    `INSERT INTO outbox(workspace_id, aggregate_type, aggregate_id, event_type, payload, available_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [e.workspaceId, e.aggregateType, e.aggregateId, e.eventType, JSON.stringify(withChangeOrigin(e.payload ?? {})), e.availableAt ?? new Date()],
  );
}

/** V3.5 loop prevention: events written while automation acts carry payload.origin (automation/origin.ts). */
function withChangeOrigin(payload: Record<string, unknown>): Record<string, unknown> {
  const o = currentOrigin();
  return o && payload.origin === undefined ? { ...payload, origin: o } : payload;
}
