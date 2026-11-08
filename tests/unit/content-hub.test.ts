// Content Hub pure functions: Docs/Notion normalization, warnings, diff, fingerprints, signatures, writeback payloads.
import { describe, expect, it } from 'vitest';
import { parseGoogleDocument } from '../../packages/services/src/content-hub/docs-parse.js';
import { blocksToText, diffLines, fingerprintSections, htmlToText, textToHtml, Warnings } from '../../packages/services/src/content-hub/normalize.js';
import { mapRow, mappingProblems } from '../../packages/services/src/content-hub/rows.js';
import { parseNotionBlocks, propertyFingerprint, simulatedProperty, writebackPayload, type TreeNode } from '../../packages/services/src/content-hub/notion-parse.js';
import { notionSignature } from '../../packages/services/src/content-hub/webhooks.js';
import { isOwnEcho } from '../../packages/services/src/content-hub/writeback.js';
import type { NotionDataSource, NotionPage } from '../../packages/services/src/content-hub/notion.js';

const p = (text: string, extra: Record<string, unknown> = {}) => ({ paragraph: { elements: [{ textRun: { content: `${text}\n` } }], ...extra } });

describe('Google Docs normalization', () => {
  const doc = {
    title: 'Brief',
    tabs: [{ tabProperties: { tabId: 't.0', title: 'A' }, documentTab: { lists: { l: { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL' }] } } }, body: { content: [
      p('Intro text'),
      { paragraph: { paragraphStyle: { namedStyleType: 'HEADING_1', headingId: 'h.1' }, elements: [{ textRun: { content: 'Plan\n' } }] } },
      p('one', { bullet: { listId: 'l', nestingLevel: 0 } }),
      { paragraph: { paragraphStyle: { namedStyleType: 'HEADING_3' }, elements: [{ textRun: { content: 'Sub\n' } }] } },
      { paragraph: { elements: [{ person: { personProperties: { name: 'Dana' } } }, { equation: {} }, { textRun: { content: ' ‮evil\n' } }] } },
      { tableOfContents: {} },
    ] } }, childTabs: [{ tabProperties: { tabId: 't.1', title: 'B' }, documentTab: { body: { content: [p('child')] } } }] }],
  };
  it('splits at H1/H2 per tab (child tabs included), keeps lists, strips bidi overrides, warns on unsupported', () => {
    const r = parseGoogleDocument(doc, 'exclude');
    expect(r.sections.map((s) => s.id)).toEqual(['t.0:intro', 't.0:h.1', 't.1:intro']);
    const plan = r.sections[1]!;
    expect(blocksToText(plan.blocks)).toBe('Plan\n1. one\nSub\nDana evil');
    const codes = r.warnings.map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['smart_chip', 'unsupported_element', 'comments_omitted', 'suggestions_excluded']));
  });
  it('fingerprint is stable and content sensitive', () => {
    const a = parseGoogleDocument(doc, 'exclude');
    expect(fingerprintSections(a.title, a.sections)).toBe(fingerprintSections(a.title, parseGoogleDocument(doc, 'exclude').sections));
    const changed = JSON.parse(JSON.stringify(doc));
    changed.tabs[0].childTabs[0].documentTab.body.content[0] = p('child!');
    const b = parseGoogleDocument(changed, 'exclude');
    expect(fingerprintSections(b.title, b.sections)).not.toBe(fingerprintSections(a.title, a.sections));
  });
});

describe('Notion normalization', () => {
  it('nested blocks, todo/toggle, unsupported disclosed, sections at headings', () => {
    const w = new Warnings();
    const tree: TreeNode[] = [
      { object: 'block', id: 'a', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Hello ', href: null }, { plain_text: 'site', href: 'https://x.test' }] } },
      { object: 'block', id: 'h', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Next' }] } },
      { object: 'block', id: 't', type: 'toggle', toggle: { rich_text: [{ plain_text: 'More' }] }, children: [{ object: 'block', id: 'c', type: 'to_do', to_do: { rich_text: [{ plain_text: 'do' }], checked: false } }] },
      { object: 'block', id: 'u', type: 'unsupported', unsupported: { block_type: 'button' } },
    ];
    const s = parseNotionBlocks('page', 'Title', tree, w);
    expect(s.map((x) => x.id)).toEqual(['page:intro', 'h']);
    expect(blocksToText(s[0]!.blocks)).toBe('Hello site (https://x.test)');
    expect(blocksToText(s[1]!.blocks)).toBe('Next\nMore\n  ☐ do');
    expect(w.list().find((x) => x.code === 'unsupported_block')!.message).toContain('button');
  });
});

describe('diff', () => {
  it('reports adds/removes with context', () => {
    const d = diffLines(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'd', 'e']);
    expect(d.lines.filter((l) => l.op !== 'same')).toEqual([{ op: 'remove', text: 'b' }, { op: 'add', text: 'B' }, { op: 'add', text: 'e' }]);
  });
});

describe('mapping + writeback', () => {
  const ds = { object: 'data_source', id: 'ds', properties: {
    Name: { id: 'title', name: 'Name', type: 'title' }, Status: { id: 'st', name: 'Status', type: 'select', select: { options: [{ name: 'Ready' }, { name: 'Published' }] } },
    Date: { id: 'dt', name: 'Date', type: 'date' }, Copy: { id: 'cp', name: 'Copy', type: 'rich_text' }, Url: { id: 'u', name: 'Url', type: 'url' },
  } } as unknown as NotionDataSource;
  it('rejects malformed mappings and loops', () => {
    expect(mappingProblems(ds, { mapping: { target_date: 'cp', title: 'zzz' }, import_statuses: [], writeback: {} }, true)).toMatchObject({ 'mapping.target_date': expect.any(String), 'mapping.title': expect.any(String) });
    expect(mappingProblems(ds, { mapping: { status: 'st' }, import_statuses: ['Published'], writeback: { status: 'st' } }, true)).toMatchObject({ import_statuses: expect.stringMatching(/written by Relay/) });
    expect(mappingProblems(ds, { mapping: { title: 'title', status: 'st' }, import_statuses: ['Ready'], writeback: { post_url: 'u' } }, true)).toEqual({});
    expect(mappingProblems(ds, { mapping: {}, import_statuses: [], writeback: { post_url: 'u' } }, false)).toMatchObject({ 'writeback.post_url': expect.any(String) });
  });
  it('maps rows with row-level errors; statuses are labels only', () => {
    const page = { object: 'page', id: 'r', properties: {
      Name: { id: 'title', type: 'title', title: [{ plain_text: 'Post' }] }, Status: { id: 'st', type: 'select', select: { name: 'Approved' } }, Date: { id: 'dt', type: 'date', date: { start: 'bad' } },
    } } as unknown as NotionPage;
    const v = mapRow(page, { mapping: { title: 'title', status: 'st', target_date: 'dt' }, import_statuses: ['Ready'] });
    expect(v.errors).toEqual(['Target date is not a valid date', 'Status “Approved” is not selected for import']);
  });
  it('writeback payload touches one property; fingerprints compare written vs simulated values', () => {
    expect(writebackPayload('url', 'https://x.test/p')).toEqual({ url: 'https://x.test/p' });
    expect(writebackPayload('rich_text', 'Scheduled')).toEqual({ rich_text: [{ type: 'text', text: { content: 'Scheduled' } }] });
    expect(propertyFingerprint(simulatedProperty('rs', 'rich_text', 'A'))).toBe(propertyFingerprint({ id: 'rs', type: 'rich_text', rich_text: [{ plain_text: 'A' }] }));
    expect(isOwnEcho([{ id: 'bot', type: 'bot' }], 'bot')).toBe(true);
    expect(isOwnEcho([{ id: 'bot', type: 'bot' }, { id: 'p', type: 'person' }], 'bot')).toBe(false);
  });
});

describe('signatures and html', () => {
  it('Notion signature is sha256= HMAC of the raw body', () => {
    expect(notionSignature('tok', '{"a":1}')).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(notionSignature('tok', '{"a":1}')).not.toBe(notionSignature('tok', '{"a": 1}'));
  });
  it('html helpers escape untrusted text', () => {
    expect(textToHtml('<t>', 'a <script>x</script>')).toContain('a &lt;script&gt;');
    expect(htmlToText('<p>a &amp; b</p><script>bad()</script>')).toBe('a & b');
  });
});
