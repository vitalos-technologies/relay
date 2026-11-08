// Relay support (V4 SUP) — shared helpers: references, activity (history + content-free change feed), search document,
// secret redaction for customer text, safe diagnostics. No authorization here (see access.ts).
import { randomInt } from 'node:crypto';
import { AppError } from '@social-lite/core';
import { BROWSER_FAMILIES, SUPPORT_CATEGORY_LABEL, type BrowserFamily, type SupportDiagnostics, type SupportTicketCategory } from '@social-lite/core/contracts/v4-support';
import { maybeOne, one, type Queryable } from '@social-lite/db';
import { safeCorrelationId } from '../gov/diagnostics.js';
import { safeRoute } from '../gov/release.js';

/** Stable customer-visible reference, e.g. RLY-482133 (random, unique; longer if the 6-digit space gets crowded). */
export async function newReference(db: Queryable): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const digits = i < 5 ? 6 : 8;
    const ref = `RLY-${randomInt(10 ** (digits - 1), 10 ** digits)}`;
    if (!(await maybeOne(db, `SELECT 1 FROM support_tickets WHERE reference=$1`, [ref]))) return ref;
  }
  throw new AppError('internal', 'Could not allocate a ticket reference');
}

export type ActivityAudience = 'customer' | 'staff';
export type ActorKind = 'member' | 'visitor' | 'staff' | 'system';

/** Append one history/change-feed row (append-only table). Returns its id (the feed cursor). */
export async function writeActivity(db: Queryable, a: {
  ticketId: string; audience: ActivityAudience; kind: string; actorKind: ActorKind; actorUserId?: string | null; refId?: string | null; detail?: Record<string, unknown>;
}): Promise<number> {
  const r = await one<{ id: string }>(db,
    `INSERT INTO support_activity(ticket_id, audience, kind, actor_kind, actor_user_id, ref_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
    [a.ticketId, a.audience, a.kind, a.actorKind, a.actorUserId ?? null, a.refId ?? null, JSON.stringify(a.detail ?? {})]);
  return Number(r.id);
}

/** Add PUBLIC text to the ticket's search document (internal notes are never passed here). */
export async function appendSearch(db: Queryable, ticketId: string, text: string): Promise<void> {
  await db.query(`UPDATE support_tickets SET search_doc = search_doc || to_tsvector('simple', $2) WHERE id=$1`, [ticketId, text.slice(0, 2000)]);
}

// ------------------------------------------------------------------ redaction (customer free text)
// Same credential patterns as problem reports (gov/release.ts) but e-mail addresses are kept: a support message often
// legitimately names the address someone signs in with.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '<redacted-auth>'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '<redacted-jwt>'],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '<redacted-bot-token>'],
  [/\b(?:sk|pk|rk|xox[abpr]|ghp|gho|ghs|github_pat|glpat|AKIA|ya29)[-_.A-Za-z0-9]{10,}/g, '<redacted-key>'],
  [/\b((?:access|refresh|id)?_?token|secret|password|passwd|pwd|api[_-]?key|client_secret|signature|authorization|cookie)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s&,;]+)/gi, '$1=<redacted>'],
  [/\b[A-Za-z0-9+/_-]{48,}={0,2}/g, '<redacted-long-value>'],
  [/\b(?:\d[ -]?){13,19}\b/g, '<redacted-number>'],
];

export function redactSecrets(input: string): { text: string; count: number } {
  let count = 0;
  let text = input.normalize('NFKC');
  for (const [re, rep] of SECRET_PATTERNS) text = text.replace(re, (...m) => { count++; return rep.replace('$1', String(m[1] ?? '')); });
  return { text, count };
}

// ------------------------------------------------------------------ diagnostics
/** Browser family from a User-Agent (family only — never the full string, version or device). */
export function browserFamily(ua: string | null | undefined): BrowserFamily | null {
  if (!ua) return null;
  if (/SamsungBrowser/i.test(ua)) return 'samsung';
  if (/Edg\//i.test(ua)) return 'edge';
  if (/OPR\/|Opera/i.test(ua)) return 'opera';
  if (/Firefox\//i.test(ua)) return 'firefox';
  if (/Chrome\/|CriOS\//i.test(ua)) return 'chrome';
  if (/Safari\//i.test(ua)) return 'safari';
  return 'other';
}

/** Keep only the allow-listed, normalised diagnostic fields (brief §6). Unknown keys are dropped. */
export function safeDiagnostics(raw: Partial<Record<keyof SupportDiagnostics, unknown>> | null | undefined): SupportDiagnostics {
  if (!raw || typeof raw !== 'object') return {};
  const out: SupportDiagnostics = {};
  if (typeof raw.app_version === 'string' && /^[A-Za-z0-9._+-]{1,64}$/.test(raw.app_version)) out.app_version = raw.app_version;
  if (typeof raw.route === 'string') { const r = safeRoute(raw.route); if (r) out.route = r; }
  if (typeof raw.occurred_at === 'string' && !Number.isNaN(Date.parse(raw.occurred_at))) out.occurred_at = new Date(raw.occurred_at).toISOString();
  if (typeof raw.browser_family === 'string' && (BROWSER_FAMILIES as readonly string[]).includes(raw.browser_family)) out.browser_family = raw.browser_family as BrowserFamily;
  if (Array.isArray(raw.correlation_ids)) {
    const ids = raw.correlation_ids.filter((x): x is string => typeof x === 'string').map(safeCorrelationId).filter((x): x is string => !!x);
    if (ids.length) out.correlation_ids = [...new Set(ids)].slice(0, 10);
  }
  if (typeof raw.error_code === 'string' && /^[a-z0-9_.-]{1,64}$/.test(raw.error_code)) out.error_code = raw.error_code;
  return out;
}

// ------------------------------------------------------------------ activity text
const REASON_LABEL: Record<string, string> = {
  answered: 'answered', fixed: 'fixed', duplicate: 'duplicate', not_reproducible: 'could not reproduce', wont_fix: 'won’t fix',
  customer_resolved: 'resolved by the customer', no_response: 'no response', other: 'other',
};

/** Human line for one activity row. Customer text never names staff members or staff-only facts. */
export function activityText(kind: string, detail: Record<string, unknown>, forStaff: boolean): string {
  const who = typeof detail.actor_name === 'string' && detail.actor_name ? detail.actor_name : null;
  switch (kind) {
    case 'ticket.created': return detail.source === 'problem_report' ? 'Request created from a problem report' : 'Request created';
    case 'status.resolved': return `Resolved${detail.reason ? ` · ${REASON_LABEL[String(detail.reason)] ?? String(detail.reason)}` : ''}${forStaff && who ? ` by ${who}` : ''}`;
    case 'status.reopened': return `Reopened${forStaff && who ? ` by ${who}` : ''}`;
    case 'status.archived': return 'Archived';
    case 'status.changed': return `Status: ${String(detail.to ?? '').replace(/_/g, ' ')}${who ? ` · ${who}` : ''}`;
    case 'participant.added': return `${String(detail.name ?? 'Someone')} was added`;
    case 'participant.removed': return `${String(detail.name ?? 'Someone')} was removed`;
    case 'report.linked': return 'A problem report was shared to this request';
    case 'access.requested': return forStaff ? `Support access requested${who ? ` by ${who}` : ''}` : 'Relay support asked for read-only access to this workspace';
    case 'access.approved': return 'Read-only support access approved';
    case 'access.declined': return 'Support access declined';
    case 'access.ended': return 'Support access ended';
    case 'assigned': return detail.to_name ? `Assigned to ${String(detail.to_name)}` : 'Unassigned';
    case 'priority.changed': return `Priority: ${String(detail.to)}`;
    case 'category.changed': return `Category: ${SUPPORT_CATEGORY_LABEL[detail.to as SupportTicketCategory] ?? String(detail.to)}`;
    case 'duplicate.marked': return `Marked as duplicate of ${String(detail.of_reference ?? '')}`;
    case 'note.created': return 'Internal note added';
    case 'message.created': return 'Message';
    default: return kind.replace(/[._]/g, ' ');
  }
}

export const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

/** First name for customer-facing staff attribution ("Sam · Relay"). */
export function staffPublicName(name: string | null): string {
  const first = name?.trim().split(/\s+/)[0];
  return first ? `${first} · Relay` : 'Relay support';
}
