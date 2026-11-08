// Rule condition evaluation (pure). Results record WHICH field matched, never the customer's text.
import type { ConditionField, RuleCondition } from '@social-lite/core/contracts/v35-automation';

export interface Facts {
  channel_kind?: string | null;
  conversation_kind?: string | null;
  category?: string | null;
  sentiment?: string | null;
  language?: string | null;
  urgency?: string | null;
  priority?: string | null;
  assigned?: boolean | null;
  text?: string | null;
  first_message?: boolean | null;
  case_change?: string | null;
  minutes_to_deadline?: number | null;
  labels?: string[] | null;
}

/** Which fields each trigger can provide (validation + builder). */
export const TRIGGER_FIELDS: Record<string, readonly ConditionField[]> = {
  'inbox.message_received': ['channel_kind', 'conversation_kind', 'category', 'sentiment', 'language', 'urgency', 'priority', 'assigned', 'text_contains', 'first_message', 'labels'],
  'case.sla_nearing': ['priority', 'assigned', 'minutes_to_deadline'],
  'case.changed': ['case_change', 'priority', 'assigned'],
  'listening.alert': [],
  'content.approved': [],
};

const OPS_FOR: Record<ConditionField, readonly RuleCondition['op'][]> = {
  channel_kind: ['in', 'not_in'], conversation_kind: ['in', 'not_in'], category: ['in', 'not_in'], sentiment: ['in', 'not_in'], language: ['in', 'not_in'],
  urgency: ['in', 'not_in'], priority: ['in', 'not_in'], assigned: ['is'], text_contains: ['contains_any'], first_message: ['is'], case_change: ['in', 'not_in'],
  minutes_to_deadline: ['lte'], labels: ['contains_any'],
};

export function conditionError(trigger: string, c: RuleCondition): string | null {
  if (!(TRIGGER_FIELDS[trigger] ?? []).includes(c.field)) return `“${c.field}” is not available for this trigger.`;
  if (!OPS_FOR[c.field].includes(c.op)) return `“${c.op}” does not apply to ${c.field}.`;
  if ((c.op === 'in' || c.op === 'not_in' || c.op === 'contains_any') && (!Array.isArray(c.value) || !c.value.length || c.value.length > 50 || c.value.some((v) => typeof v !== 'string' || !v.trim() || v.length > 60))) return 'Give 1–50 values.';
  if (c.op === 'is' && typeof c.value !== 'boolean') return 'Use true or false.';
  if (c.op === 'lte' && (typeof c.value !== 'number' || !Number.isFinite(c.value) || c.value < 0 || c.value > 10_080)) return 'Use 0–10080 minutes.';
  return null;
}

function one(c: RuleCondition, f: Facts): boolean {
  const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);
  switch (c.op) {
    case 'in':
    case 'not_in': {
      const v = c.field === 'assigned' ? null : lower(f[c.field as keyof Facts]);
      const inList = v !== null && v !== undefined && (c.value as string[]).map((x) => x.toLowerCase()).includes(String(v));
      return c.op === 'in' ? inList : !inList;
    }
    case 'is': return (f[c.field as keyof Facts] ?? false) === c.value;
    case 'contains_any': {
      const needles = (c.value as string[]).map((x) => x.toLowerCase().trim()).filter(Boolean);
      if (c.field === 'labels') return (f.labels ?? []).some((l) => needles.includes(l.toLowerCase()));
      const hay = (f.text ?? '').toLowerCase();
      return needles.some((n) => hay.includes(n));
    }
    case 'lte': {
      const v = f[c.field as keyof Facts];
      return typeof v === 'number' && v <= (c.value as number);
    }
  }
}

/** All conditions must match (AND). Empty ⇒ matches. */
export function evaluateConditions(conds: RuleCondition[], f: Facts): { matched: boolean; results: Array<{ field: ConditionField; matched: boolean }> } {
  const results = conds.map((c) => ({ field: c.field, matched: one(c, f) }));
  return { matched: results.every((r) => r.matched), results };
}
