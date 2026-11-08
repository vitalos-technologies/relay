// V3.5 connector registry: definitions (scopes, inbound mechanism, prerequisites — mirrored in
// docs/v3-5/CAPABILITY_MATRIX.md), webhook verifiers, inbound event handlers and sync-job executors.
// Stream C registers handlers/executors per connector; the foundation ships the definitions + verifiers.
import type {
  ConnectorDefinition, ConnectorKey, InboundEventHandler, InboundRequest, SyncJobExecutor, VerifyResult,
} from '@social-lite/core/contracts/v35-connectors';
import { CONNECTOR_KEYS } from '@social-lite/core/contracts/v35-connectors';
import { getSetting, isSettingKey } from '../settings.js';
import { verifyAsana, verifyHubspotV3, verifyMailchimp, verifyMetaSha256, verifyMonday, verifySlack } from './verify.js';

const V = '2026-11-07';

export const CONNECTORS: Record<ConnectorKey, ConnectorDefinition> = {
  asana: {
    key: 'asana', name: 'Asana', auth: 'oauth2_pkce', scopes: ['tasks:read', 'tasks:write', 'projects:read', 'users:read', 'webhooks:write'], inbound: 'webhook_hmac',
    resourceTypes: ['workspace', 'project'], prerequisites: ['Asana developer app (OAuth) registered by the operator', 'Webhooks are at-most-once: polling fallback required for completeness'],
    hosts: ['app.asana.com'], docsUrl: 'https://developers.asana.com/docs/webhooks-guide', verifiedOn: V,
  },
  monday: {
    key: 'monday', name: 'monday.com', auth: 'oauth2', scopes: ['boards:read', 'boards:write', 'users:read', 'webhooks:write'], inbound: 'webhook_jwt',
    resourceTypes: ['board', 'group', 'column'], prerequisites: ['monday app with OAuth + signing secret (webhooks are JWT-signed only when created with the app token)'],
    hosts: ['api.monday.com', 'auth.monday.com'], docsUrl: 'https://developer.monday.com/api-reference/reference/webhooks', verifiedOn: V,
  },
  hubspot: {
    key: 'hubspot', name: 'HubSpot', auth: 'oauth2', scopes: ['crm.objects.contacts.read', 'crm.objects.companies.read', 'tickets', 'crm.objects.owners.read'], inbound: 'webhook_signed_ts',
    resourceTypes: ['pipeline', 'owner'], prerequisites: ['HubSpot public app (OAuth) + client secret for v3 webhook signatures', 'Ticket scopes need a Service Hub-enabled portal'],
    hosts: ['api.hubapi.com', 'app.hubspot.com'], docsUrl: 'https://developers.hubspot.com/docs/api/webhooks/validating-requests', verifiedOn: V,
  },
  google_business_profile: {
    key: 'google_business_profile', name: 'Google Business Profile', auth: 'oauth2', scopes: ['https://www.googleapis.com/auth/business.manage'], inbound: 'pubsub_push',
    resourceTypes: ['account', 'location'], prerequisites: ['Google approval of Business Profile API access (quota is 0 until approved)', 'Cloud Pub/Sub topic for review notifications (a separately billed Google Cloud service)', 'Chat is discontinued (July 2024) and not offered'],
    hosts: ['mybusiness.googleapis.com', 'mybusinessbusinessinformation.googleapis.com', 'mybusinessaccountmanagement.googleapis.com', 'businessprofileperformance.googleapis.com'],
    docsUrl: 'https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews', verifiedOn: V,
  },
  google_translate: {
    key: 'google_translate', name: 'Google Cloud Translation', auth: 'service_account', scopes: ['https://www.googleapis.com/auth/cloud-translation'], inbound: 'none',
    resourceTypes: ['glossary'], prerequisites: ['Google Cloud project with the Cloud Translation API enabled and billing (paid per character)', 'Glossaries need Translation Advanced (v3)'],
    hosts: ['translation.googleapis.com'], docsUrl: 'https://cloud.google.com/translate/docs', verifiedOn: V,
  },
  slack: {
    key: 'slack', name: 'Slack', auth: 'oauth2', scopes: ['chat:write', 'channels:read', 'groups:read', 'users:read', 'users:read.email'], inbound: 'webhook_signed_ts',
    resourceTypes: ['channel'], prerequisites: ['Slack app (OAuth v2) + signing secret; interactivity URL for approval buttons'],
    hosts: ['slack.com'], docsUrl: 'https://docs.slack.dev/authentication/verifying-requests-from-slack', verifiedOn: V,
  },
  mailchimp: {
    key: 'mailchimp', name: 'Mailchimp', auth: 'oauth2', scopes: [], inbound: 'webhook_hmac',
    resourceTypes: ['audience', 'campaign'], prerequisites: ['Mailchimp OAuth app (Marketing API); scopes are account-wide (no granular scopes)', 'Webhook signature optional; URL secret otherwise'],
    hosts: ['login.mailchimp.com'], docsUrl: 'https://mailchimp.com/developer/marketing/guides/sync-audience-data-webhooks/', verifiedOn: V,
  },
  whatsapp: {
    key: 'whatsapp', name: 'WhatsApp Business Platform', auth: 'system_user_token', scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'], inbound: 'webhook_hmac',
    resourceTypes: ['phone_number', 'message_template'], prerequisites: ['Meta Business verification + WhatsApp Business Account + registered phone number', 'Per-message charges (since 2025-07-01); payment method on the WABA', 'Free-form replies only inside the 24 h customer service window; otherwise approved templates'],
    hosts: ['graph.facebook.com'], docsUrl: 'https://developers.facebook.com/docs/whatsapp/pricing', verifiedOn: V,
  },
};

export const isConnectorKey = (k: string): k is ConnectorKey => (CONNECTOR_KEYS as readonly string[]).includes(k);

/** Secret lookup: setup-page setting when the key is registered (stream C adds keys), else the deployment env. */
export async function secretSetting(key: string): Promise<string | null> {
  if (isSettingKey(key)) return (await getSetting(key)) ?? null;
  return process.env[key] ?? null;
}

export interface VerifierContext {
  /** Per-installation secret (Asana hook secret, Mailchimp URL key), decrypted by the ingress. */
  installationSecret: string | null;
  query: URLSearchParams;
}

export type Verifier = (req: InboundRequest, v: VerifierContext) => Promise<VerifyResult>;

const VERIFIERS: Record<ConnectorKey, Verifier> = {
  slack: async (req) => verifySlack(req, await secretSetting('SLACK_SIGNING_SECRET'), await secretSetting('SLACK_SIGNING_SECRET_PREVIOUS')),
  hubspot: async (req) => verifyHubspotV3(req, await secretSetting('HUBSPOT_CLIENT_SECRET')),
  asana: async (req, v) => verifyAsana(req, v.installationSecret),
  monday: async (req) => verifyMonday(req, await secretSetting('MONDAY_SIGNING_SECRET')),
  mailchimp: async (req, v) => verifyMailchimp(req, await secretSetting('MAILCHIMP_WEBHOOK_SECRET'), v.query.get('key'), v.installationSecret),
  whatsapp: async (req) => verifyMetaSha256(req, await secretSetting('META_APP_SECRET')),
  // Pub/Sub push carries a Google-signed OIDC token; verification (JWKS) is owned by stream C. Until then: refused.
  google_business_profile: async () => ({ ok: false, reason: 'not_configured' }),
  // Translation has no inbound events.
  google_translate: async () => ({ ok: false, reason: 'not_configured' }),
};

export function verifierFor(connector: ConnectorKey): Verifier {
  return VERIFIERS[connector];
}

/** Stream C may replace a verifier (e.g. Pub/Sub OIDC). Never register one that accepts unsigned requests. */
export function registerVerifier(connector: ConnectorKey, v: Verifier): void {
  VERIFIERS[connector] = v;
}

const HANDLERS = new Map<ConnectorKey, InboundEventHandler>();
export function registerInboundHandler(h: InboundEventHandler): void { HANDLERS.set(h.connector, h); }
export function inboundHandler(connector: string): InboundEventHandler | null { return isConnectorKey(connector) ? HANDLERS.get(connector) ?? null : null; }

const EXECUTORS = new Map<string, SyncJobExecutor>();
export function registerSyncExecutor(e: SyncJobExecutor): void { EXECUTORS.set(e.kind, e); }
export function syncExecutor(kind: string): SyncJobExecutor | null { return EXECUTORS.get(kind) ?? null; }
/** Test seam: clear registrations. */
export function resetConnectorRegistrationsForTests(): void { HANDLERS.clear(); EXECUTORS.clear(); }
