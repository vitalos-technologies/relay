// V3.5 stream C — business integrations (Asana, monday.com, HubSpot, Google Business Profile, Cloud Translation,
// Slack, Mailchimp). DTOs shared by services, API routes and the Integrations hub UI. No IO.
// Builds on contracts/v35-connectors.ts (installations, resources, mappings, links, events, sync jobs).
import type { ConnectorKey, IntegrationConnectionJson, IntegrationResourceJson } from './v35-connectors';

export const HUB_CONNECTORS = ['asana', 'monday', 'hubspot', 'google_business_profile', 'google_translate', 'slack', 'mailchimp'] as const;
export type HubConnector = (typeof HUB_CONNECTORS)[number];

/** URL slug ↔ connector key (/integrations/<slug>). */
export const CONNECTOR_SLUG: Record<HubConnector, string> = {
  asana: 'asana', monday: 'monday', hubspot: 'hubspot', google_business_profile: 'google-business-profile',
  google_translate: 'google-translate', slack: 'slack', mailchimp: 'mailchimp',
};
export const slugToConnector = (slug: string): HubConnector | null =>
  (Object.entries(CONNECTOR_SLUG).find(([, s]) => s === slug)?.[0] as HubConnector | undefined) ?? null;

/** Operator readiness (Instance setup / secret manager). Values are never returned, only whether they are set. */
export interface ConnectorSetupJson {
  connector: HubConnector;
  name: string;
  /** Every required operator setting is present. */
  configured: boolean;
  missing_settings: string[];
  redirect_uri: string | null;
  webhook_url: string | null;
  scopes: string[];
  prerequisites: string[];
  docs_url: string;
  verified_on: string;
  /** Simulated installs allowed here (development/demo only; never production). */
  simulation_available: boolean;
  capabilities: string[];
  /** Setup values (missing setting names, redirect/webhook URLs) are shown only to the instance owner and platform
   *  operators (stream F); everyone else sees "Ask your Relay admin to set up …". */
  setup_details_visible?: boolean;
}

export interface HubConnectorJson extends ConnectorSetupJson {
  installations: IntegrationConnectionJson[];
}

export interface HubOverviewJson { connectors: HubConnectorJson[]; can_manage: boolean }

/** Resource the provider says is available for explicit selection (nothing is imported until selected). */
export interface AvailableResourceJson { resource_type: string; external_id: string; name: string; url: string | null; detail?: string | null; selected: boolean }

export interface InstallationDetailJson {
  integration: IntegrationConnectionJson;
  setup: ConnectorSetupJson;
  resources: IntegrationResourceJson[];
  can_manage: boolean;
}

// ------------------------------------------------------------------ external work items (Asana / monday.com)
export type TaskStatus = 'open' | 'in_progress' | 'done';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskRelayType = 'post' | 'campaign' | 'conversation' | 'case' | 'listening_alert' | 'insight';

export interface ExternalTaskJson {
  id: string;
  integration_id: string;
  connector: 'asana' | 'monday';
  relay_type: TaskRelayType;
  relay_id: string;
  resource_id: string | null;
  resource_name: string | null;
  external_id: string | null;
  external_url: string | null;
  title: string;
  description: string | null;
  due_on: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  external_status: string | null;
  external_assignee: string | null;
  link_state: 'pending' | 'linked' | 'unavailable' | 'unlinked' | 'failed';
  link_detail: string | null;
  in_sync: boolean;
  conflict: Record<string, { relay: unknown; external: unknown }> | null;
  last_pulled_at: string | null;
  is_simulated: boolean;
  /** Relay-side version (optimistic concurrency for edits). */
  version: number;
}

/** Preview of exactly what leaves Relay (brief §4). */
export interface OutboundPreviewJson {
  connector: ConnectorKey;
  destination: string;
  fields: Array<{ label: string; value: string }>;
  excluded: string[];
}

/** Two-way task fields (explicit mapping required); everything else is Relay → external only. */
export const TASK_SYNC_FIELDS = ['title', 'due_on', 'status'] as const;

// ------------------------------------------------------------------ HubSpot
export interface HubspotContactJson { id: string; name: string; email_masked: string | null; company: string | null; url: string | null }
export interface HubspotTicketJson { id: string; subject: string; pipeline: string | null; stage: string | null; priority: string | null; owner: string | null; url: string | null; fetched_at: string | null }

// ------------------------------------------------------------------ Google Business Profile
export type GbpPostState = 'waiting_approval' | 'scheduled' | 'publishing' | 'live' | 'processing' | 'rejected' | 'failed' | 'needs_review' | 'cancelled' | 'unknown';
export interface GbpLocalPostJson {
  id: string; integration_id: string; location_resource_id: string; location_name: string; post_id: string; schedule_id: string; summary: string;
  state: GbpPostState; state_detail: string | null; due_at: string; external_url: string | null; is_simulated: boolean; created_at: string;
}
/** Hard cap: one request may target at most this many locations (prevents accidental mass updates). */
export const GBP_MAX_LOCATIONS_PER_REQUEST = 10;

/**
 * Interface for stream B (reviews in the inbox): the GBP installation + its explicitly selected locations.
 * `location_name` is the v4 resource name accounts/{a}/locations/{l} used by reviews.list / updateReply / deleteReply.
 */
export interface GbpLocationJson { integration_id: string; resource_id: string; brand_id: string | null; location_name: string; title: string; is_simulated: boolean; access_state: 'ok' | 'unavailable' }

// ------------------------------------------------------------------ Slack
export const SLACK_CATEGORIES = ['approvals', 'assignments', 'connection_alerts', 'delivery_alerts', 'care_escalations', 'listening_alerts', 'summaries'] as const;
export type SlackCategory = (typeof SLACK_CATEGORIES)[number];
/** Categories that may reference customer conversations: private channels only. */
export const SLACK_PRIVATE_ONLY: readonly SlackCategory[] = ['assignments', 'care_escalations'];

export interface SlackRouteJson {
  id: string; integration_id: string; resource_id: string; channel_name: string; channel_private: boolean; categories: SlackCategory[];
  brand_ids: string[] | null; quiet_start: string | null; quiet_end: string | null; timezone: string; max_per_hour: number; summary_time: string | null; enabled: boolean;
}
export interface SlackDeliveryJson {
  id: string; route_id: string; channel_name: string; category: string; text: string; state: 'queued' | 'deferred' | 'sending' | 'sent' | 'failed' | 'suppressed' | 'unknown';
  state_detail: string | null; created_at: string; sent_at: string | null; attempts: number;
}

// ------------------------------------------------------------------ Cloud Translation
export type TranslationSourceType = 'inbox_message' | 'reply_draft' | 'post_variant' | 'listening_result' | 'text';
export interface TranslationSettingsJson {
  enabled: boolean; allow_customer_content: boolean; monthly_char_cap: number; glossary_id: string | null;
  billing_acknowledged_at: string | null; price_per_million_usd: number; price_checked_on: string;
  usage: { month_characters: number; month_cost_estimate_usd: number; month_requests: number; failures_30d: number };
  connected: boolean; is_simulated: boolean; can_manage: boolean;
}
export interface TranslationJson {
  id: string; source_type: TranslationSourceType; source_id: string | null; source_lang: string | null; detected: boolean; target_lang: string;
  original_text: string; translated_text: string; machine_translated: true; glossary_id: string | null; characters: number;
  cost_estimate_usd: number; is_simulated: boolean; created_at: string;
}

// ------------------------------------------------------------------ Mailchimp
export interface MailchimpExportJson {
  job_id: string; state: string; post_id: string; audience_id: string; audience_name: string | null; campaign_id: string | null; campaign_url: string | null;
  status: string | null; report: { emails_sent: number | null; opens: number | null; clicks: number | null; unsubscribed: number | null } | null;
  fetched_at: string | null; created_at: string; is_simulated: boolean;
}

export type HubResourcesResult = { items: AvailableResourceJson[] };
