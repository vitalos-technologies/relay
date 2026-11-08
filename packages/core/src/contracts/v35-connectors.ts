// V3.5 shared connector + event contracts (stream FOUNDATION, migration 028). Every V3.5 stream builds on these:
//  - business integrations (stream C) register a ConnectorDefinition, store installations in integration_connections
//    (credentials stay in the existing envelope-encrypted `credentials` vault), and use the generic webhook ingress,
//    durable sync jobs, external links and field mappings below;
//  - inbox (B), listening (D) and AI/automation (E) consume the event types and workload classes defined here.
// Services: packages/services/src/integrations/** (see docs/V3_5_WORKSTREAMS.md). No IO in this file.

// ------------------------------------------------------------------ connectors
export const CONNECTOR_KEYS = [
  'asana', 'monday', 'hubspot', 'google_business_profile', 'google_translate', 'slack', 'mailchimp', 'whatsapp',
] as const;
export type ConnectorKey = (typeof CONNECTOR_KEYS)[number];

export type ConnectorAuth = 'oauth2' | 'oauth2_pkce' | 'service_account' | 'api_key' | 'system_user_token';

/** How Relay learns about external changes. */
export type InboundMechanism =
  | 'webhook_hmac'       // HMAC over the raw body with a shared/app secret (Asana, Meta/WhatsApp, Mailchimp)
  | 'webhook_signed_ts'  // HMAC over timestamp + body, replay window (Slack, HubSpot v3)
  | 'webhook_jwt'        // signed JWT in Authorization (monday.com app webhooks)
  | 'pubsub_push'        // Google Cloud Pub/Sub push with an OIDC token (Google Business Profile notifications)
  | 'polling'            // no push; bounded, quota-aware polling with a cursor
  | 'none';

export interface ConnectorDefinition {
  key: ConnectorKey;
  name: string;
  auth: ConnectorAuth;
  /** Least-privilege scopes requested at connect time. */
  scopes: readonly string[];
  inbound: InboundMechanism;
  /** Resource types a user must explicitly select (nothing is imported automatically). */
  resourceTypes: readonly string[];
  /** Provider review / commercial prerequisites, verbatim in the capability matrix. */
  prerequisites: readonly string[];
  /** Hosts the live transport may call for this connector (added to the allow-list by the owning stream). */
  hosts: readonly string[];
  docsUrl: string;
  /** Date the official docs were last checked (YYYY-MM-DD). */
  verifiedOn: string;
}

export type IntegrationStatus = 'pending' | 'active' | 'needs_attention' | 'reconnect_required' | 'paused' | 'disconnected';

export interface IntegrationConnectionJson {
  id: string;
  connector: ConnectorKey;
  brand_id: string | null;          // null = workspace scope
  external_account_id: string;
  display_name: string;
  status: IntegrationStatus;
  is_simulated: boolean;
  granted_scopes: string[];
  missing_scopes: string[];
  paused: boolean;
  paused_reason: string | null;
  health: { message: string; checked_at: string | null };
  last_success_at: string | null;
  last_error: { at: string; code: string | null } | null;
  rate_limit: RateLimitObservation | null;
  created_at: string;
  disconnected_at: string | null;
}

/** Only what the provider actually reported (headers / quota endpoints). Absent ⇒ "not observable". */
export interface RateLimitObservation {
  remaining: number | null;
  limit: number | null;
  reset_at: string | null;
  observed_at: string;
  source: string;                    // e.g. 'X-RateLimit-Remaining', 'Retry-After', 'quota endpoint'
}

export interface IntegrationResourceJson {
  id: string;
  integration_id: string;
  resource_type: string;
  external_id: string;
  name: string;
  url: string | null;
  selected: boolean;
  access_state: 'ok' | 'unavailable';
}

// ------------------------------------------------------------------ synchronization contract (brief §3)
export type SourceOfTruth = 'relay' | 'external';
export type SyncDirection = 'relay_to_external' | 'external_to_relay' | 'two_way';
/** Never "last write wins" for protected fields; conflicts are explicit. */
export type ConflictBehavior = 'source_wins' | 'manual_review' | 'skip';
export type DeletionBehavior = 'unlink' | 'mark_unavailable' | 'archive_relay' | 'ignore';
export type RevocationBehavior = 'mark_unavailable' | 'pause';

export interface FieldMapping {
  id: string;
  integration_id: string;
  resource_id: string | null;
  relay_object: string;     // e.g. 'case', 'post', 'conversation'
  relay_field: string;      // e.g. 'title', 'priority'
  external_field: string;   // provider field / column id
  source_of_truth: SourceOfTruth;
  direction: SyncDirection;
  conflict: ConflictBehavior;
  on_delete: DeletionBehavior;
  on_revoke: RevocationBehavior;
  /** Ownership / approval / consent / customer-sensitive: two-way is refused (DB check + service). */
  protected: boolean;
  enabled: boolean;
  version: number;
}

/** Fields that may never sync two-way and never change Relay approval/publishing state. */
export const PROTECTED_RELAY_FIELDS = ['approval_state', 'publish_state', 'owner', 'assignee', 'consent', 'subscription_status', 'customer_email', 'customer_phone'] as const;

export type ExternalLinkStatus = 'linked' | 'unavailable' | 'unlinked';
export type RelayObjectType = 'post' | 'campaign' | 'conversation' | 'case' | 'contact' | 'customer' | 'review' | 'listening_alert' | 'insight';

export interface ExternalLinkJson {
  id: string;
  integration_id: string;
  connector: ConnectorKey;
  relay_type: RelayObjectType;
  relay_id: string;
  external_type: string;
  external_id: string;
  external_url: string | null;
  status: ExternalLinkStatus;
  status_detail: string | null;
  last_synced_at: string | null;
}

// ------------------------------------------------------------------ inbound events (generic webhook ingress)
export type InboundEventState = 'pending' | 'processing' | 'processed' | 'ignored' | 'failed' | 'dead';

/** Result of verifying one inbound HTTP request. Unverified requests are never persisted or processed. */
export type VerifyResult =
  | { ok: true; kind: 'event'; dedupeKey: string; eventType: string; externalAccountId: string | null; occurredAt: string | null; summary: Record<string, unknown> }
  | { ok: true; kind: 'handshake'; response: { status: number; headers?: Record<string, string>; body: string } }
  | { ok: false; reason: 'not_configured' | 'bad_signature' | 'stale' | 'malformed' };

export interface InboundRequest {
  rawBody: string;
  headers: Record<string, string>;   // lower-case names
  method: string;
  /** Path + query as received (HubSpot v3 signs the full URI). */
  uri: string;
  now: Date;
}

/** Secret material for a verifier, resolved server-side (setup page / secret manager). Never logged. */
export interface VerifierSecrets { secret: string | null; previousSecret?: string | null }

/** Max age of signed-timestamp webhooks (Slack, HubSpot v3, Mailchimp signature): 5 minutes. */
export const WEBHOOK_MAX_SKEW_MS = 5 * 60_000;

/** Handler a stream registers for a connector's verified events (runs in the worker, workload class integration_sync). */
export interface InboundEventHandler {
  connector: ConnectorKey;
  /** Load current state through the API (events are signals), apply via mappings, return what happened. */
  handle(event: { id: string; workspaceId: string | null; integrationId: string | null; eventType: string; body: unknown; origin: 'external' | 'relay_echo' }): Promise<{ outcome: 'processed' | 'ignored'; detail?: string }>;
}

// ------------------------------------------------------------------ outbound sync jobs
export type SyncJobState = 'queued' | 'running' | 'waiting_retry' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';

export interface SyncJobRequest {
  integrationId: string;
  /** '<connector>.<action>', e.g. 'asana.create_task', 'hubspot.create_ticket'. */
  kind: string;
  relayType: RelayObjectType;
  relayId: string;
  /**
   * Deterministic key: the same logical request (e.g. "case X → HubSpot ticket") always maps to one job, so repeated
   * delivery creates one external record. Default: `${kind}:${relayType}:${relayId}`.
   */
  idempotencyKey?: string;
  /** Minimal payload (ids, approved summary). Never whole private conversations by default. */
  payload: Record<string, unknown>;
}

export interface SyncJobJson {
  id: string;
  integration_id: string;
  kind: string;
  relay_type: RelayObjectType;
  relay_id: string;
  state: SyncJobState;
  attempts: number;
  next_attempt_at: string | null;
  external_id: string | null;
  last_error: { code: string | null; message: string | null } | null;
  created_at: string;
  finished_at: string | null;
}

/** What a sync-job executor returns. 'unknown' = the provider may have acted; reconcile, never blindly retry. */
export type SyncOutcome =
  | { kind: 'succeeded'; externalId?: string | null; externalUrl?: string | null; result?: Record<string, unknown> }
  | { kind: 'retry'; code: string; message: string; retryAfterMs?: number; rateLimit?: Omit<RateLimitObservation, 'observed_at'> }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'unknown'; code: string; message: string };

export interface SyncJobExecutor {
  kind: string;
  run(job: { id: string; workspaceId: string; integrationId: string; relayType: RelayObjectType; relayId: string; payload: Record<string, unknown>; attempt: number; originMarker: string }): Promise<SyncOutcome>;
  /** Look the record up by origin marker / external id after an 'unknown' outcome. */
  reconcile?(job: { id: string; integrationId: string; originMarker: string; payload: Record<string, unknown> }): Promise<{ found: true; externalId: string; externalUrl?: string | null } | { found: false }>;
}

/**
 * Origin marker embedded in records Relay writes (custom field, description footer, external id) so that the webhook
 * echo of Relay's own write is recognised and dropped — the loop-prevention rule for every two-way mapping.
 */
export const ORIGIN_MARKER_PREFIX = 'relay:';
export const originMarker = (jobId: string) => `${ORIGIN_MARKER_PREFIX}${jobId}`;

export const SYNC_RETRY = { maxAttempts: 6, baseMs: 30_000, maxMs: 30 * 60_000 } as const;
export function syncBackoffMs(attempt: number, retryAfterMs?: number): number {
  const exp = Math.min(SYNC_RETRY.maxMs, SYNC_RETRY.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.max(exp, retryAfterMs ?? 0);
}

// ------------------------------------------------------------------ health / diagnostics
export interface IntegrationHealthJson {
  integration: IntegrationConnectionJson;
  events: { pending: number; failed_24h: number; last_received_at: string | null };
  jobs: { queued: number; running: number; failed_24h: number; unknown: number; oldest_queued_age_seconds: number | null };
  activity: IntegrationActivityJson[];
}

export interface IntegrationActivityJson {
  at: string;
  kind: 'sync' | 'health' | 'webhook' | 'auth' | 'rate_limit';
  outcome: 'ok' | 'error' | 'retry' | 'throttled';
  code: string | null;
  message: string | null;
  http_status: number | null;
}
