// Integrations hub: per-connector presentation (icons, resource types, synchronization contract shown to people).
import { Contact, Hash, Languages, LayoutGrid, ListChecks, Mail, Store, type LucideIcon } from 'lucide-react';
import type { HubConnector } from '@social-lite/core/contracts/v35-integrations';

export interface ConnectorMeta {
  name: string;
  icon: LucideIcon;
  /** One line under the name. */
  blurb: string;
  /** Resource types offered for explicit selection: [type, label]. */
  resources: Array<[string, string]>;
  /** Synchronization contract rows: field, source of truth, direction, on delete, on revoke. */
  contract: Array<[string, string, string, string, string]>;
}

const REVOKE = 'Link marked unavailable';
export const CONNECTOR_META: Record<HubConnector, ConnectorMeta> = {
  asana: { name: 'Asana', icon: ListChecks, blurb: 'Tasks from posts, campaigns, conversations and cases', resources: [['project', 'Projects']],
    contract: [['Title, due date, status', 'Relay', 'Relay → Asana (two-way if mapped)', 'Relay record kept', REVOKE], ['Priority, description', 'Relay', 'Relay → Asana', 'Relay record kept', REVOKE], ['Assignee', 'Relay', 'Relay → Asana only', '—', REVOKE], ['Approval / publishing', 'Relay', 'Never synced', '—', '—']] },
  monday: { name: 'monday.com', icon: LayoutGrid, blurb: 'Items on boards you choose', resources: [['board', 'Boards']],
    contract: [['Name, date, status column', 'Relay', 'Relay → monday (two-way if mapped)', 'Relay record kept', REVOKE], ['Priority column', 'Relay', 'Relay → monday', 'Relay record kept', REVOKE], ['Approval / publishing', 'Relay', 'Never synced', '—', '—']] },
  hubspot: { name: 'HubSpot', icon: Contact, blurb: 'CRM context and support tickets', resources: [['pipeline', 'Ticket pipelines'], ['owner', 'Owners']],
    contract: [['Ticket subject, priority, stage', 'Relay at creation', 'Relay → HubSpot once; stage shown in Relay', 'Link marked unavailable', REVOKE], ['Case state', 'Relay', 'Never changed by HubSpot', '—', '—'], ['Contact link', 'Person who links', 'Explicit only; reversible', 'Link marked unavailable', REVOKE], ['Marketing consent', 'HubSpot', 'Not inferred from a link', '—', '—']] },
  google_business_profile: { name: 'Google Business Profile', icon: Store, blurb: 'Local posts, metrics and reviews for chosen locations', resources: [['location', 'Locations']],
    contract: [['Local post text', 'Approved Relay revision', 'Relay → Google at the scheduled time', 'Delete in Google', REVOKE], ['Reviews + owner replies', 'Google', 'Google → Inbox; replies via Inbox', 'Customer reviews are never deleted', 'Paused']] },
  google_translate: { name: 'Google Cloud Translation', icon: Languages, blurb: 'Machine translation with originals kept', resources: [['glossary', 'Glossaries']],
    contract: [['Original text', 'Relay', 'Never modified', '—', '—'], ['Translation', 'Provider', 'Stored separately, labelled', '—', 'Translation off']] },
  slack: { name: 'Slack', icon: Hash, blurb: 'Alerts and approvals in channels you choose', resources: [['channel', 'Channels']],
    contract: [['Alert text', 'Relay', 'Relay → Slack (minimal, with a Relay link)', '—', 'Alerts stop'], ['Approvals', 'Relay', 'Slack button → Relay approval checks', '—', 'Buttons refused']] },
  mailchimp: { name: 'Mailchimp', icon: Mail, blurb: 'Draft campaigns from approved posts', resources: [['audience', 'Audiences'], ['campaign', 'Campaigns']],
    contract: [['Campaign draft', 'Approved Relay revision', 'Relay → Mailchimp (draft only)', 'Link marked unavailable', REVOKE], ['Audience members', 'Mailchimp', 'Never changed by Relay', '—', '—'], ['Sending', 'Mailchimp', 'Only in Mailchimp', '—', '—']] },
};

export const STATUS_LABEL: Record<string, { label: string; tone: 'success' | 'warn' | 'neutral' | 'danger' | 'info' }> = {
  active: { label: 'Connected', tone: 'success' }, pending: { label: 'Checking', tone: 'info' }, needs_attention: { label: 'Needs attention', tone: 'warn' },
  reconnect_required: { label: 'Reconnect', tone: 'danger' }, paused: { label: 'Paused', tone: 'neutral' }, disconnected: { label: 'Disconnected', tone: 'neutral' },
};

export const JOB_LABEL: Record<string, string> = {
  'asana.task': 'Create task', 'asana.push_task': 'Update task', 'monday.task': 'Create item', 'monday.push_task': 'Update item', 'hubspot.ticket': 'Create ticket',
  'hubspot.add_note': 'Add note', 'gbp.local_post': 'Google post', 'mailchimp.campaign': 'Draft campaign',
};

export const JOB_STATE: Record<string, { label: string; tone: 'success' | 'warn' | 'neutral' | 'danger' | 'info' }> = {
  queued: { label: 'Queued', tone: 'info' }, running: { label: 'Running', tone: 'info' }, waiting_retry: { label: 'Retrying', tone: 'warn' }, succeeded: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' }, unknown: { label: 'Not confirmed', tone: 'warn' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
};
