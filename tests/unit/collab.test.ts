// Collaboration pure helpers (packages/core/src/collab.ts): mention tokens, body sanitising, safe rich-text tokens,
// anchors (outdated after later edits), change summaries, apply-selected merge, bounded reminders.
import { describe, expect, it } from 'vitest';
import {
  anchorStatus, applyFields, changeSummary, changedFields, mentionIds, parseAnchor, plainMentions, reminderDue, sanitizeCommentBody, tokenizeComment,
  type DraftContent,
} from '@social-lite/core';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const draft = (over: Partial<DraftContent> = {}): DraftContent => ({ baseText: 'Hello brave world', baseLink: null, baseAssetIds: [], variants: [{ connectionId: C, inheritText: true, inheritMedia: true }], ...over });

describe('mentions + sanitising', () => {
  it('extracts unique identity tokens (case-insensitive), max 20', () => {
    expect(mentionIds(`hi @[${A}] and @[${A.toUpperCase()}] @[${B}] @[not-a-uuid]`)).toEqual([A, B]);
    const many = Array.from({ length: 30 }, (_, i) => `@[${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111]`).join(' ');
    expect(mentionIds(many)).toHaveLength(20);
  });
  it('strips control and bidi characters, collapses blank lines, keeps text otherwise', () => {
    expect(sanitizeCommentBody('  a\u0000b‮c\r\n\n\n\nd  ')).toBe('abc\n\nd');
    expect(sanitizeCommentBody(`<script>x</script> @[${A.toUpperCase()}]`)).toBe(`<script>x</script> @[${A}]`); // rendered as text, never HTML
  });
  it('plain mentions for text-only contexts', () => {
    expect(plainMentions(`hi @[${A}] @[${B}]`, { [A]: 'Ann' })).toBe('hi @Ann @someone');
  });
});

describe('rich text tokens', () => {
  it('only http(s) links; markup is a fixed small subset', () => {
    const t = tokenizeComment(`**bold** _it_ \`code\` https://ex.com/a. javascript:alert(1) @[${A}]\nnext`);
    expect(t.filter((x) => x.t !== 'text').map((x) => x.t)).toEqual(['bold', 'italic', 'code', 'link', 'mention', 'br']);
    expect(t.find((x) => x.t === 'link')).toMatchObject({ href: 'https://ex.com/a' });
    expect(JSON.stringify(t)).not.toContain('"href":"javascript');
  });
});

describe('anchors', () => {
  it('validates untrusted anchors', () => {
    expect(parseAnchor({ kind: 'text', field: 'base', quote: 'brave' })).toMatchObject({ kind: 'text', field: 'base', quote: 'brave' });
    expect(parseAnchor({ kind: 'text', field: 'variant', quote: 'x' })).toBeNull(); // variant needs a connection
    expect(parseAnchor({ kind: 'media', asset_id: 'nope' })).toBeNull();
    expect(parseAnchor({ kind: 'text', field: 'base', quote: '   ' })).toBeNull();
  });
  it('current → moved (later edits, still present) → outdated (gone); no anchor = none', () => {
    const a = parseAnchor({ kind: 'text', field: 'base', quote: 'brave' });
    expect(anchorStatus(a, 3, 3, draft())).toBe('current');
    expect(anchorStatus(a, 3, 5, draft())).toBe('moved');
    expect(anchorStatus(a, 3, 5, draft({ baseText: 'Hello world' }))).toBe('outdated');
    expect(anchorStatus(null, 1, 9, draft())).toBe('none');
    expect(anchorStatus({ kind: 'media', asset_id: A }, 1, 2, draft({ baseAssetIds: [] }))).toBe('outdated');
  });
});

describe('version comparison + merge', () => {
  it('lists changed fields and summarises them', () => {
    const f = changedFields({ title: 't', draft: draft() }, { title: 't2', draft: draft({ baseText: 'x', baseLink: 'https://a' }) });
    expect(f).toEqual(['title', 'text', 'link']);
    expect(changeSummary(f)).toBe('Changed title, text and link');
    expect(changeSummary([])).toBe('No content changes');
  });
  it('applies only the selected fields of mine on top of the latest version', () => {
    const latest = { title: 'Theirs', draft: draft({ baseText: 'Their text', baseLink: 'https://theirs' }) };
    const mine = { title: 'Mine', draft: draft({ baseText: 'My text', baseLink: 'https://mine', variants: [...draft().variants, { connectionId: A, inheritText: true, inheritMedia: true }] }) };
    const out = applyFields(latest, mine, ['text', 'destinations']);
    expect(out.title).toBe('Theirs');
    expect(out.draft.baseLink).toBe('https://theirs');
    expect(out.draft.baseText).toBe('My text');
    expect(out.draft.variants.map((v) => v.connectionId)).toEqual([C, A]);
  });
});

describe('reminders', () => {
  const base = { dueAt: new Date('2030-01-02T12:00:00Z'), leadHours: 24, maxOverdue: 2, remindedSoonFor: null, overdueReminders: 0, lastRemindedAt: null };
  it('one "soon" per deadline inside the lead window', () => {
    expect(reminderDue({ ...base, now: new Date('2030-01-01T11:00:00Z') })).toBeNull();
    expect(reminderDue({ ...base, now: new Date('2030-01-01T13:00:00Z') })).toEqual({ kind: 'soon' });
    expect(reminderDue({ ...base, now: new Date('2030-01-01T13:00:00Z'), remindedSoonFor: base.dueAt })).toBeNull();
  });
  it('overdue at most N times, 24 h apart', () => {
    const now = new Date('2030-01-03T12:00:00Z');
    expect(reminderDue({ ...base, now })).toEqual({ kind: 'overdue', n: 1 });
    expect(reminderDue({ ...base, now, overdueReminders: 1, lastRemindedAt: new Date('2030-01-03T00:00:00Z') })).toBeNull();
    expect(reminderDue({ ...base, now, overdueReminders: 1, lastRemindedAt: new Date('2030-01-02T11:00:00Z') })).toEqual({ kind: 'overdue', n: 2 });
    expect(reminderDue({ ...base, now, overdueReminders: 2, lastRemindedAt: new Date('2030-01-01T00:00:00Z') })).toBeNull();
  });
});
