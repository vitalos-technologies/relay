// V3.5 event + workload contract (stream FOUNDATION). Domain changes write ONE transactional outbox row
// (packages/services/src/outbox.ts) and the dispatcher routes it to a dedicated pg-boss queue with a deterministic job id.
// Consumers reload rows by id and re-check authority; payloads carry ids only (no message bodies, no personal data).
//
// Queues and workload classes keep customer replies and publishing apart from bulk work (brief §19):
//   publishing      → deliveries (existing, reserved capacity, never deferred)
//   customer_reply  → 'inbox-reply'       main pool, never deferred, own gate (a listening import can never delay a reply)
//   inbox_ingest    → 'inbox-events'      main pool, never deferred, small (normalise + persist + route)
//   integration_sync→ 'integration-sync'  bulk pool, defers under publishing pressure, per-workspace cap
//   listening_ingest→ 'listening-ingest'  bulk pool, defers, cap 1 per workspace (stream D)
//   ai_assist       → 'ai-assist'         bulk pool, not deferred (a person may be waiting), budget-gated (stream E)

export const V35_OUTBOX_EVENTS = [
  'inbox.message_received',   // aggregate: inbox_conversations.id  payload: { messageId, channelId, kind }
  'inbox.reply_requested',    // aggregate: inbox_reply_attempts.id
  'inbox.reply_finished',     // aggregate: inbox_reply_attempts.id  payload: { state }
  'inbox.assigned',           // aggregate: inbox_conversations.id  payload: { assigneeId, previousAssigneeId }
  'inbox.note_added',         // aggregate: inbox_notes.id          payload: { conversationId, mentions }
  'case.changed',             // aggregate: care_cases.id           payload: { change: 'created'|'state'|'owner'|'breach'|'escalated' }
  'integration.event_received', // aggregate: integration_events.id
  'integration.sync_requested',  // aggregate: integration_sync_jobs.id
] as const;
export type V35OutboxEvent = (typeof V35_OUTBOX_EVENTS)[number];

export const V35_QUEUES = {
  inboxReply: 'inbox-reply',
  inboxEvents: 'inbox-events',
  integrationSync: 'integration-sync',
  listeningIngest: 'listening-ingest',
  aiAssist: 'ai-assist',
} as const;

/** Event type → queue (merged into WORKLOAD_QUEUES in engine/outbox-dispatcher.ts). */
export const V35_EVENT_QUEUES: Record<V35OutboxEvent, string> = {
  'inbox.message_received': V35_QUEUES.inboxEvents,
  'inbox.reply_requested': V35_QUEUES.inboxReply,
  'inbox.reply_finished': V35_QUEUES.inboxEvents,
  'inbox.assigned': V35_QUEUES.inboxEvents,
  'inbox.note_added': V35_QUEUES.inboxEvents,
  'case.changed': V35_QUEUES.inboxEvents,
  'integration.event_received': V35_QUEUES.integrationSync,
  'integration.sync_requested': V35_QUEUES.integrationSync,
};

/** New workload classes (added to WORKLOAD_CLASSES in v31-perf.ts; DB check widened in 028). */
export const V35_WORKLOAD_CLASSES = ['customer_reply', 'inbox_ingest', 'integration_sync', 'listening_ingest', 'ai_assist'] as const;

/**
 * Subscribers for inbox/case events (automation in stream E, Slack alerts in stream C, listening in D) register through
 * services/inbox/hooks.ts `onInboxEvent(name, fn)`. Hooks run AFTER commit in the 'inbox-events' consumer, receive ids
 * only, must be idempotent (at-least-once), and may never send a customer reply directly — they call the same domain
 * services (requestReply etc.) with a service actor so permission, policy and idempotency checks apply.
 */
export interface InboxHookEvent {
  name: V35OutboxEvent;
  workspaceId: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  /** Set when the change was made by an automation run; hooks must ignore their own origin (loop prevention). */
  origin: { kind: 'user' | 'provider' | 'automation' | 'system'; id: string | null };
}
