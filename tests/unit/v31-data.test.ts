// V3.1 DATA pure logic: search tokenisation (no tsquery injection), snippet highlight parsing, bulk request validation.
import { beforeAll, describe, expect, it } from 'vitest';
import { BULK_ACTION_PERMISSION, BULK_ASSET_ACTIONS, BULK_POST_ACTIONS, SETTINGS_DESTINATIONS } from '@social-lite/core/contracts/v31-data';
import { PERMISSIONS } from '@social-lite/core';
import { resetConfigCache } from '@social-lite/services';

beforeAll(() => { process.env.DATABASE_URL ??= 'postgres://unit-test'; resetConfigCache(); });

describe('search terms', () => {
  it('keeps letters/digits only, lower-cased, bounded, deduplicated', async () => {
    const { searchTerms, toTsQuery } = await import('@social-lite/services/data/search');
    expect(searchTerms("Arsenal' | !:* & (Spurs) arsenal")).toEqual(['arsenal', 'spurs']);
    expect(searchTerms('Ünïcode čafé 2026')).toEqual(['ünïcode', 'čafé', '2026']);
    expect(searchTerms('a b c d e f g h')).toHaveLength(6);
    expect(searchTerms('x'.repeat(500))[0]).toHaveLength(40);
    expect(searchTerms('  !!! ')).toEqual([]);
    expect(toTsQuery(['arsenal', 'spurs'])).toBe('arsenal:* & spurs:*');
  });

  it('parses headline markers into plain text + highlight ranges', async () => {
    const { parseHeadline } = await import('@social-lite/services/data/search');
    const h = parseHeadline('Matchday \u0001Arsenal\u0002 travel  north \u0001arsenal\u0002');
    expect(h.text).toBe('Matchday Arsenal travel north arsenal');
    expect(h.highlights.map(([s, e]) => h.text!.slice(s, e))).toEqual(['Arsenal', 'arsenal']);
    expect(parseHeadline(null)).toEqual({ text: null, highlights: [] });
    expect(parseHeadline('<b>x</b>').text).toBe('<b>x</b>'); // plain text: the UI must render it as text, never HTML
  });
});

describe('bulk contracts', () => {
  it('every action maps to a real permission', () => {
    for (const a of BULK_POST_ACTIONS) expect(PERMISSIONS).toContain(BULK_ACTION_PERMISSION[`post.${a}`]);
    for (const a of BULK_ASSET_ACTIONS) expect(PERMISSIONS).toContain(BULK_ACTION_PERMISSION[`asset.${a}`]);
    for (const d of SETTINGS_DESTINATIONS) if (d.requires) expect(PERMISSIONS).toContain(d.requires);
  });

  it('validates requests (bounded, typed params)', async () => {
    const { validateRequest } = await import('@social-lite/services/data/bulk');
    const id = '6b1d2b4e-58f7-4d0a-9d47-4a2f1d1f5c11';
    expect(validateRequest({ target_kind: 'post', action: 'add_tags', item_ids: [id, id], params: { tags: [' a ', 'a', 'b'] } })).toEqual({ ids: [id], params: { tags: ['a', 'b'] } });
    expect(() => validateRequest({ target_kind: 'asset', action: 'duplicate' as never, item_ids: [id] })).toThrow(/not available/);
    expect(() => validateRequest({ target_kind: 'post', action: 'archive', item_ids: Array.from({ length: 501 }, () => crypto.randomUUID()) })).toThrow(/at most 500/);
    expect(() => validateRequest({ target_kind: 'post', action: 'reschedule', item_ids: [id], params: { shift_minutes: 0 } })).toThrow(/Shift/);
    expect(() => validateRequest({ target_kind: 'post', action: 'assign', item_ids: [id], params: {} })).toThrow(/person or a team/);
    expect(() => validateRequest({ target_kind: 'post', action: 'archive', item_ids: ['nope'] })).toThrow(/Invalid item id/);
  });
});
