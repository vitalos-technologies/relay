import type { AutomationActionType, AutomationTrigger, ConditionField, PolicyStatus, RunOutcome } from '@social-lite/core/contracts/v35-automation';

export const TRIGGER_LABEL: Record<AutomationTrigger, string> = {
  'inbox.message_received': 'New customer message',
  'case.sla_nearing': 'Case nearing its deadline',
  'case.changed': 'Case changed',
  'listening.alert': 'Listening alert',
  'content.approved': 'Content approved',
};

export const ACTION_LABEL: Record<AutomationActionType, string> = {
  assign: 'Assign / route',
  set_priority: 'Set priority',
  add_labels: 'Add labels',
  add_note: 'Internal note',
  create_case: 'Create case',
  notify: 'Notify',
  escalate: 'Escalate to a person',
  reply_saved: 'Reply with saved reply',
  reply_ai: 'AI reply from approved knowledge',
  integration_job: 'Integration action',
};

export const FIELD_LABEL: Record<ConditionField, string> = {
  channel_kind: 'Channel', conversation_kind: 'Type', category: 'Category', sentiment: 'Sentiment', language: 'Language', urgency: 'Urgency',
  priority: 'Priority', assigned: 'Assigned', text_contains: 'Message contains', first_message: 'First message', case_change: 'Case change',
  minutes_to_deadline: 'Minutes to deadline', labels: 'Has label',
};

export const OUTCOME_LABEL: Record<RunOutcome, string> = {
  pending: 'Pending', succeeded: 'Done', partial: 'Partly done', skipped: 'Skipped', blocked: 'Blocked', escalated: 'Escalated', failed: 'Failed', test: 'Test',
};
export const OUTCOME_TONE: Record<RunOutcome, 'success' | 'warn' | 'danger' | 'neutral' | 'info'> = {
  pending: 'info', succeeded: 'success', partial: 'warn', skipped: 'neutral', blocked: 'warn', escalated: 'info', failed: 'danger', test: 'neutral',
};

export const POLICY_STATUS_LABEL: Record<PolicyStatus, string> = { draft: 'Draft', active: 'Active', paused: 'Paused', stopped: 'Stopped', expired: 'Expired' };
export const POLICY_STATUS_TONE: Record<PolicyStatus, 'success' | 'warn' | 'danger' | 'neutral'> = { draft: 'neutral', active: 'success', paused: 'warn', stopped: 'danger', expired: 'danger' };

export const CATEGORY_LABEL: Record<string, string> = {
  question: 'Question', order_status: 'Order status', pricing: 'Pricing', refund: 'Refund', complaint: 'Complaint', praise: 'Praise', feedback: 'Feedback',
  support: 'Support', sales: 'Sales', spam: 'Spam', sensitive: 'Sensitive', other: 'Other',
};
