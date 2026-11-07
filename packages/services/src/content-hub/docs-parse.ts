// Google Docs (documents.get with includeTabsContent=true) → normalized sections. Pure.
// Headings, lists (ordered/unordered, nesting) and links are preserved; everything the importer cannot represent
// produces a visible warning (never silent loss). Comments are never requested; suggestions follow the chosen mode.
import type { ImportWarning, NormalizedBlock, NormalizedLink, NormalizedSection, SuggestionsMode } from '@social-lite/core/contracts/content-hub';
import { cleanText, finishSection, Warnings } from './normalize.js';
import type { DocsSuggestionsView } from './google.js';

export const SUGGESTIONS_VIEW: Record<SuggestionsMode, DocsSuggestionsView> = {
  exclude: 'PREVIEW_WITHOUT_SUGGESTIONS',
  accept: 'PREVIEW_SUGGESTIONS_ACCEPTED',
  inline: 'SUGGESTIONS_INLINE',
};

interface TextStyle { link?: { url?: string; tabId?: string; heading?: unknown; bookmark?: unknown } }
interface ParagraphElement {
  textRun?: { content?: string; textStyle?: TextStyle; suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[] };
  inlineObjectElement?: unknown; person?: { personProperties?: { name?: string; email?: string } };
  richLink?: { richLinkProperties?: { title?: string; uri?: string } }; dateElement?: { dateElementProperties?: { displayText?: string } };
  pageBreak?: unknown; columnBreak?: unknown; horizontalRule?: unknown; footnoteReference?: unknown; equation?: unknown; autoText?: unknown; dropdown?: unknown;
}
interface StructuralElement {
  paragraph?: { elements?: ParagraphElement[]; paragraphStyle?: { namedStyleType?: string; headingId?: string }; bullet?: { listId?: string; nestingLevel?: number } };
  table?: { tableRows?: Array<{ tableCells?: Array<{ content?: StructuralElement[] }> }> };
  tableOfContents?: unknown; sectionBreak?: unknown;
}
interface DocumentTab {
  body?: { content?: StructuralElement[] };
  lists?: Record<string, { listProperties?: { nestingLevels?: Array<{ glyphType?: string; glyphSymbol?: string }> } }>;
  footnotes?: Record<string, unknown>; positionedObjects?: Record<string, unknown>; headers?: Record<string, unknown>;
}
interface Tab { tabProperties?: { tabId?: string; title?: string; nestingLevel?: number }; childTabs?: Tab[]; documentTab?: DocumentTab }
export interface GoogleDocument { documentId?: string; title?: string; revisionId?: string; tabs?: Tab[]; body?: DocumentTab['body']; lists?: DocumentTab['lists'] }

const ORDERED_GLYPHS = new Set(['DECIMAL', 'ZERO_DECIMAL', 'UPPER_ALPHA', 'ALPHA', 'UPPER_ROMAN', 'ROMAN']);
const HEADING_LEVEL: Record<string, number> = { TITLE: 1, HEADING_1: 1, SUBTITLE: 2, HEADING_2: 2, HEADING_3: 3, HEADING_4: 4, HEADING_5: 5, HEADING_6: 6 };
/** Headings at or above this level start a new selectable section. */
const SPLIT_LEVEL = 2;

/** Depth-first, UI order (parent before children), as documented for tab traversal. */
export function flattenTabs(tabs: Tab[] | undefined): Tab[] {
  const out: Tab[] = [];
  const walk = (ts: Tab[] | undefined) => { for (const t of ts ?? []) { out.push(t); walk(t.childTabs); } };
  walk(tabs);
  return out;
}

function paragraphBlock(p: NonNullable<StructuralElement['paragraph']>, tab: DocumentTab, w: Warnings, sectionId: () => string, mode: SuggestionsMode): NormalizedBlock | null {
  let text = '';
  const links: NormalizedLink[] = [];
  for (const el of p.elements ?? []) {
    if (el.textRun) {
      const tr = el.textRun;
      if (mode === 'inline' && (tr.suggestedInsertionIds?.length || tr.suggestedDeletionIds?.length)) {
        w.add('suggestions_inline', 'Suggested edits are shown inline (both suggested insertions and deletions are included).', sectionId());
      }
      const content = cleanText(tr.content ?? '');
      const url = tr.textStyle?.link?.url;
      if (url && /^https?:\/\//i.test(url)) links.push({ text: content.replace(/\n$/, '').trim(), url });
      text += content;
    } else if (el.inlineObjectElement) {
      w.add('inline_image_skipped', 'Images inside the Doc are not imported. Pick the image files from Drive instead.', sectionId());
    } else if (el.person) {
      const pp = el.person.personProperties;
      text += pp?.name ?? pp?.email ?? '';
      w.add('smart_chip', 'People chips were imported as plain names.', sectionId());
    } else if (el.richLink) {
      const rp = el.richLink.richLinkProperties;
      const title = cleanText(rp?.title ?? rp?.uri ?? '');
      if (rp?.uri && /^https?:\/\//i.test(rp.uri)) links.push({ text: title, url: rp.uri });
      text += title;
    } else if (el.dateElement) {
      text += cleanText(el.dateElement.dateElementProperties?.displayText ?? '');
      w.add('smart_chip', 'Date chips were imported as plain text.', sectionId());
    } else if (el.equation) {
      w.add('unsupported_element', 'Equations are not imported.', sectionId());
    } else if (el.footnoteReference) {
      w.add('unsupported_element', 'Footnotes are not imported.', sectionId());
    } else if (el.dropdown) {
      w.add('unsupported_element', 'Dropdown chips are not imported.', sectionId());
    } else if (el.horizontalRule) {
      return { type: 'divider', text: '' };
    }
    // pageBreak / columnBreak / autoText: layout only — ignored without loss of text.
  }
  text = text.replace(/\n$/, '');
  const style = p.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
  const level = HEADING_LEVEL[style];
  if (level) return { type: 'heading', text: text.trim(), level, links: links.length ? links : undefined };
  if (p.bullet) {
    const depth = Math.max(0, Math.min(p.bullet.nestingLevel ?? 0, 8));
    const lvl = tab.lists?.[p.bullet.listId ?? '']?.listProperties?.nestingLevels?.[depth];
    const ordered = !!lvl?.glyphType && ORDERED_GLYPHS.has(lvl.glyphType) && !lvl.glyphSymbol;
    return { type: 'list_item', text, depth, ordered, links: links.length ? links : undefined };
  }
  if (!text.trim()) return null;
  return { type: 'paragraph', text, links: links.length ? links : undefined };
}

export interface ParsedDocument { title: string; sections: NormalizedSection[]; warnings: ImportWarning[]; tabCount: number }

export function parseGoogleDocument(doc: GoogleDocument, mode: SuggestionsMode): ParsedDocument {
  const w = new Warnings();
  const title = cleanText(doc.title ?? 'Untitled document').slice(0, 300);
  // includeTabsContent=true ⇒ content lives in tabs[]; tolerate the legacy single-body shape.
  const tabs: Tab[] = doc.tabs?.length ? flattenTabs(doc.tabs) : [{ tabProperties: { tabId: 't.0', title }, documentTab: { body: doc.body, lists: doc.lists } }];
  const sections: NormalizedSection[] = [];
  if (mode === 'exclude') w.add('suggestions_excluded', 'Suggested edits were excluded (document shown without suggestions).');
  w.add('comments_omitted', 'Comments are never imported.');

  for (const tab of tabs) {
    const tabId = tab.tabProperties?.tabId ?? `t.${sections.length}`;
    const tabTitle = cleanText(tab.tabProperties?.title ?? title);
    const dt = tab.documentTab ?? {};
    let current: { id: string; title: string; level: number; blocks: NormalizedBlock[] } = { id: `${tabId}:intro`, title: tabTitle, level: 0, blocks: [] };
    let paraIndex = 0;
    const flush = () => {
      if (current.blocks.some((b) => b.text.trim() || b.type === 'divider')) {
        sections.push(finishSection({ id: current.id, title: current.title, tab_id: tabId, tab_title: tabTitle, level: current.level, blocks: current.blocks }));
      }
    };
    const sid = () => current.id;
    const walk = (content: StructuralElement[] | undefined, inTable: boolean) => {
      for (const el of content ?? []) {
        if (el.paragraph) {
          paraIndex++;
          const b = paragraphBlock(el.paragraph, dt, w, sid, mode);
          if (!b) continue;
          if (!inTable && b.type === 'heading' && (b.level ?? 9) <= SPLIT_LEVEL && b.text) {
            flush();
            const hid = el.paragraph.paragraphStyle?.headingId;
            current = { id: `${tabId}:${hid ?? `p${paraIndex}`}`, title: b.text.slice(0, 300), level: b.level ?? 1, blocks: [b] };
          } else {
            current.blocks.push(b);
          }
        } else if (el.table) {
          w.add('table_flattened', 'Tables were imported as text rows ("cell | cell").', sid());
          for (const row of el.table.tableRows ?? []) {
            const cells = (row.tableCells ?? []).map((c) => {
              const inner: NormalizedBlock[] = [];
              for (const ce of c.content ?? []) if (ce.paragraph) { const b = paragraphBlock(ce.paragraph, dt, w, sid, mode); if (b) inner.push(b); }
              return inner.map((b) => b.text).join(' ').replace(/\s+/g, ' ').trim();
            });
            if (cells.some(Boolean)) current.blocks.push({ type: 'table_row', text: cells.join(' | ') });
          }
        } else if (el.tableOfContents) {
          w.add('unsupported_element', 'Tables of contents are skipped.', sid());
        }
        // sectionBreak: layout only.
      }
    };
    walk(dt.body?.content, false);
    flush();
    if (dt.positionedObjects && Object.keys(dt.positionedObjects).length) w.add('inline_image_skipped', 'Positioned images are not imported.', null, Object.keys(dt.positionedObjects).length);
    if (dt.footnotes && Object.keys(dt.footnotes).length) w.add('unsupported_element', 'Footnote text is not imported.', null, Object.keys(dt.footnotes).length);
    if (dt.headers && Object.keys(dt.headers).length) w.add('unsupported_element', 'Headers and footers are not imported.');
  }
  return { title, sections, warnings: w.list(), tabCount: tabs.length };
}
