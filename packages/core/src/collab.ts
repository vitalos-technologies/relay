// Collaboration helpers shared by server and browser (pure; no IO).
//  - Comment bodies are plain text with a tiny, safe markup: **bold**, _italic_, `code`, http(s) links and mention tokens
//    `@[<user uuid>]`. Mentions are stored as identity references; names are resolved at read time. Bodies are always
//    rendered as text nodes (never HTML), so markup in user content is inert.
//  - Anchors tie a thread to selected text or a media item of the draft version it was started on; `anchorStatus`
//    says whether the anchor still matches the current draft ("outdated" after later edits).
//  - Draft change summaries + structured comparisons for version history.
//  - Bounded, timezone-aware task reminder decisions.
import type { DraftContent } from './types.js';

export const COMMENT_MAX = 5000;
export const MENTION_MAX = 20;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MENTION_RE = new RegExp(`@\\[(${UUID})\\]`, 'gi');

/** Unique mentioned user ids, in order of first appearance (max MENTION_MAX). */
export function mentionIds(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    const id = m[1]!.toLowerCase();
    if (!out.includes(id)) out.push(id);
    if (out.length >= MENTION_MAX) break;
  }
  return out;
}

/**
 * Normalise an untrusted comment body: strip control characters (keep \n and \t), collapse >2 blank lines, trim, and
 * lowercase mention ids. Throws-free; callers check the length.
 */
export function sanitizeCommentBody(raw: string): string {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(MENTION_RE, (_m, id: string) => `@[${id.toLowerCase()}]`)
    .trim();
}

/** Replace mention tokens with plain "@Name" (for text-only contexts such as previews); unknown ids → "@someone". */
export function plainMentions(body: string, names: Record<string, string>): string {
  return body.replace(MENTION_RE, (_m, id: string) => `@${names[id.toLowerCase()] ?? 'someone'}`);
}

export type RichToken =
  | { t: 'text'; v: string } | { t: 'bold'; v: string } | { t: 'italic'; v: string } | { t: 'code'; v: string }
  | { t: 'link'; v: string; href: string } | { t: 'mention'; id: string } | { t: 'br' };

/** Tokenise a body for rendering as React text nodes. Links: http(s) only. */
export function tokenizeComment(body: string): RichToken[] {
  const out: RichToken[] = [];
  const re = new RegExp(`(@\\[(${UUID})\\])|(\\*\\*([^*\\n]{1,500})\\*\\*)|(\`([^\`\\n]{1,500})\`)|(\\b_([^_\\n]{1,500})_\\b)|(https?:\\/\\/[^\\s<>()"']{1,500})|(\\n)`, 'gi');
  let last = 0;
  for (const m of body.matchAll(re)) {
    if (m.index! > last) out.push({ t: 'text', v: body.slice(last, m.index) });
    if (m[1]) out.push({ t: 'mention', id: m[2]!.toLowerCase() });
    else if (m[3]) out.push({ t: 'bold', v: m[4]! });
    else if (m[5]) out.push({ t: 'code', v: m[6]! });
    else if (m[7]) out.push({ t: 'italic', v: m[8]! });
    else if (m[9]) {
      const url = m[9].replace(/[.,;:!?]+$/, '');
      out.push({ t: 'link', v: url, href: url });
      if (url.length < m[9].length) out.push({ t: 'text', v: m[9].slice(url.length) });
    } else if (m[10]) out.push({ t: 'br' });
    last = m.index! + m[0].length;
  }
  if (last < body.length) out.push({ t: 'text', v: body.slice(last) });
  return out;
}

// ------------------------------------------------------------------ anchors
export type ThreadAnchor =
  | { kind: 'text'; field: 'base' | 'variant'; connection_id?: string | null; quote: string; prefix?: string; suffix?: string }
  | { kind: 'media'; asset_id: string };

/** Validate an untrusted anchor; returns a normalised copy or null when unusable. */
export function parseAnchor(a: unknown): ThreadAnchor | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  const uuid = new RegExp(`^${UUID}$`, 'i');
  if (o.kind === 'media' && typeof o.asset_id === 'string' && uuid.test(o.asset_id)) return { kind: 'media', asset_id: o.asset_id.toLowerCase() };
  if (o.kind === 'text' && (o.field === 'base' || o.field === 'variant') && typeof o.quote === 'string') {
    const quote = o.quote.slice(0, 500);
    if (!quote.trim()) return null;
    if (o.field === 'variant' && !(typeof o.connection_id === 'string' && uuid.test(o.connection_id))) return null;
    return {
      kind: 'text', field: o.field, connection_id: o.field === 'variant' ? String(o.connection_id).toLowerCase() : null, quote,
      prefix: typeof o.prefix === 'string' ? o.prefix.slice(-40) : '', suffix: typeof o.suffix === 'string' ? o.suffix.slice(0, 40) : '',
    };
  }
  return null;
}

function anchorText(d: DraftContent, a: Extract<ThreadAnchor, { kind: 'text' }>): string | null {
  if (a.field === 'base') return d.baseText ?? '';
  const v = d.variants.find((x) => x.connectionId === a.connection_id);
  if (!v) return null;
  return v.inheritText === false ? (v.text ?? '') : (d.baseText ?? '');
}

/** 'current' = anchored version is the current one; 'moved' = later edits but the anchor still matches; 'outdated' = gone. */
export function anchorStatus(anchor: ThreadAnchor | null, anchorVersion: number | null, currentVersion: number, current: DraftContent): 'none' | 'current' | 'moved' | 'outdated' {
  if (!anchor) return 'none'; // a general comment isn't tied to text, so later edits don't make it outdated
  const sameVersion = anchorVersion !== null && anchorVersion === currentVersion;
  if (anchor.kind === 'media') {
    const present = current.baseAssetIds.includes(anchor.asset_id) || current.variants.some((v) => (v.assetIds ?? []).includes(anchor.asset_id));
    return !present ? 'outdated' : sameVersion ? 'current' : 'moved';
  }
  const text = anchorText(current, anchor);
  if (text === null || !text.includes(anchor.quote)) return 'outdated';
  return sameVersion ? 'current' : 'moved';
}

// ------------------------------------------------------------------ version comparison
export type DraftField = 'title' | 'text' | 'link' | 'media' | 'destinations' | 'variants' | 'options';

export interface DraftSnapshot { title: string | null; draft: DraftContent }

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Which fields differ between two snapshots (stable order). */
export function changedFields(a: DraftSnapshot, b: DraftSnapshot): DraftField[] {
  const out: DraftField[] = [];
  if ((a.title ?? '') !== (b.title ?? '')) out.push('title');
  if ((a.draft.baseText ?? '') !== (b.draft.baseText ?? '')) out.push('text');
  if ((a.draft.baseLink ?? null) !== (b.draft.baseLink ?? null)) out.push('link');
  const media = (d: DraftContent) => [d.baseAssetIds, d.variants.map((v) => [v.connectionId, v.inheritMedia, v.assetIds ?? []])];
  if (!same(media(a.draft), media(b.draft))) out.push('media');
  const dest = (d: DraftContent) => d.variants.map((v) => v.connectionId).sort();
  if (!same(dest(a.draft), dest(b.draft))) out.push('destinations');
  const vtext = (d: DraftContent) => d.variants.map((v) => [v.connectionId, v.inheritText, v.inheritText === false ? v.text ?? '' : null, v.link ?? null, v.buttons ?? null]).sort();
  if (!same(vtext(a.draft), vtext(b.draft))) out.push('variants');
  const opts = (d: DraftContent) => d.variants.map((v) => [v.connectionId, v.options ?? null]).sort();
  if (!same(opts(a.draft), opts(b.draft))) out.push('options');
  return out;
}

const FIELD_LABEL: Record<DraftField, string> = {
  title: 'title', text: 'text', link: 'link', media: 'media', destinations: 'destinations', variants: 'network versions', options: 'publishing options',
};

/** "Edited text and media" style summary. */
export function changeSummary(fields: DraftField[]): string {
  if (!fields.length) return 'No content changes';
  const labels = fields.map((f) => FIELD_LABEL[f]);
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  return `Changed ${list}`;
}

/**
 * Apply the chosen fields of `mine` onto `latest` (conflict resolution: "apply selected changes to latest").
 * Destinations/variants/options are applied per destination so the other person's unrelated work is kept.
 */
export function applyFields(latest: DraftSnapshot, mine: DraftSnapshot, fields: DraftField[]): DraftSnapshot {
  const out: DraftSnapshot = { title: latest.title, draft: { ...latest.draft, variants: latest.draft.variants.map((v) => ({ ...v })) } };
  if (fields.includes('title')) out.title = mine.title;
  if (fields.includes('text')) out.draft.baseText = mine.draft.baseText;
  if (fields.includes('link')) out.draft.baseLink = mine.draft.baseLink ?? null;
  if (fields.includes('media')) {
    out.draft.baseAssetIds = [...mine.draft.baseAssetIds];
    out.draft.variants = out.draft.variants.map((v) => {
      const m = mine.draft.variants.find((x) => x.connectionId === v.connectionId);
      return m ? { ...v, inheritMedia: m.inheritMedia, assetIds: m.assetIds } : v;
    });
  }
  if (fields.includes('destinations')) {
    const keep = out.draft.variants.filter((v) => mine.draft.variants.some((m) => m.connectionId === v.connectionId));
    const added = mine.draft.variants.filter((m) => !out.draft.variants.some((v) => v.connectionId === m.connectionId));
    out.draft.variants = [...keep, ...added.map((v) => ({ ...v }))];
  }
  if (fields.includes('variants') || fields.includes('options')) {
    out.draft.variants = out.draft.variants.map((v) => {
      const m = mine.draft.variants.find((x) => x.connectionId === v.connectionId);
      if (!m) return v;
      let n = { ...v };
      if (fields.includes('variants')) n = { ...n, inheritText: m.inheritText, text: m.text, link: m.link, buttons: m.buttons };
      if (fields.includes('options')) n = { ...n, options: m.options };
      return n;
    });
  }
  return out;
}

// ------------------------------------------------------------------ reminders
export interface ReminderInput {
  now: Date; dueAt: Date; leadHours: number; maxOverdue: number;
  remindedSoonFor: Date | null; overdueReminders: number; lastRemindedAt: Date | null;
}

/**
 * Bounded reminder decision. 'soon': once per due date, within `leadHours` before it. 'overdue': first one once the due
 * time passes, then at most once per 24 h, at most `maxOverdue` in total. Quiet hours/time zone of the recipient are
 * applied by the notification pipeline (in-app now, email deferred).
 */
export function reminderDue(r: ReminderInput): null | { kind: 'soon' } | { kind: 'overdue'; n: number } {
  const t = r.now.getTime();
  const due = r.dueAt.getTime();
  if (t < due) {
    if (due - t <= r.leadHours * 3600_000 && (!r.remindedSoonFor || r.remindedSoonFor.getTime() !== due)) return { kind: 'soon' };
    return null;
  }
  if (r.overdueReminders >= r.maxOverdue) return null;
  if (r.overdueReminders > 0 && r.lastRemindedAt && t - r.lastRemindedAt.getTime() < 24 * 3600_000) return null;
  return { kind: 'overdue', n: r.overdueReminders + 1 };
}

export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'completed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['open', 'in_progress', 'blocked'];

/** Presence freshness (seconds). */
export const PRESENCE = { heartbeat: 20, live: 60, recent: 300, purge: 600 } as const;
