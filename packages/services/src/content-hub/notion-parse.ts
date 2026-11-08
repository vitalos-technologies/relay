// Notion blocks/properties → normalized model. Pure (the bounded recursive fetch lives in notion-fetch.ts).
// Unsupported blocks and incomplete fetches are disclosed as warnings. Notion statuses and property values are
// configuration/content only — never trusted as Relay roles or approval.
import type { NormalizedBlock, NormalizedLink, NormalizedSection } from '@social-lite/core/contracts/content-hub';
import { stableStringify } from '../idempotency.js';
import { cleanText, finishSection, sha256Hex, type Warnings } from './normalize.js';
import type { NotionBlock, NotionPage, NotionPropertyValue, RichText } from './notion.js';

export type TreeNode = NotionBlock & { children?: TreeNode[] };

export function richTextPlain(rt: RichText[] | undefined): { text: string; links: NormalizedLink[] } {
  let text = '';
  const links: NormalizedLink[] = [];
  for (const r of rt ?? []) {
    const t = cleanText(r.plain_text ?? r.text?.content ?? '');
    const href = r.href ?? r.text?.link?.url ?? null;
    if (href && /^https?:\/\//i.test(href)) links.push({ text: t.trim(), url: href });
    text += t;
  }
  return { text, links };
}

const withLinks = (b: NormalizedBlock, links: NormalizedLink[]): NormalizedBlock => (links.length ? { ...b, links } : b);

/** Media from a file/image/video/pdf block. Notion-hosted URLs expire (1 h) and are never stored. */
export function blockFile(block: NotionBlock): { kind: 'image' | 'video' | 'file'; hosted: boolean; url: string | null; name: string | null } | null {
  if (!['image', 'video', 'file', 'pdf', 'audio'].includes(block.type)) return null;
  const f = block[block.type] as { type?: string; file?: { url?: string }; external?: { url?: string }; name?: string } | undefined;
  if (!f) return null;
  const kind = block.type === 'image' ? 'image' : block.type === 'video' ? 'video' : 'file';
  const hosted = f.type === 'file';
  return { kind, hosted, url: (hosted ? f.file?.url : f.external?.url) ?? null, name: f.name ?? null };
}

function convert(node: TreeNode, depth: number, w: Warnings, sid: () => string, out: NormalizedBlock[]): void {
  if (node.in_trash || node.archived) return;
  const t = node.type;
  const data = (node[t] ?? {}) as { rich_text?: RichText[]; checked?: boolean; language?: string; url?: string; caption?: RichText[]; title?: string; expression?: string; cells?: RichText[][] };
  const rt = richTextPlain(data.rich_text);
  const recurse = (d = depth + 1) => { for (const c of node.children ?? []) convert(c, d, w, sid, out); };
  switch (t) {
    case 'paragraph':
      if (rt.text.trim()) out.push(withLinks({ type: 'paragraph', text: rt.text, depth: depth || undefined }, rt.links));
      recurse();
      return;
    case 'heading_1': case 'heading_2': case 'heading_3': case 'heading_4':
      out.push(withLinks({ type: 'heading', text: rt.text.trim(), level: Number(t.slice(-1)) }, rt.links));
      recurse(depth); // toggleable headings
      return;
    case 'bulleted_list_item': case 'numbered_list_item':
      out.push(withLinks({ type: 'list_item', text: rt.text, ordered: t === 'numbered_list_item', depth }, rt.links));
      recurse();
      return;
    case 'to_do':
      out.push(withLinks({ type: 'todo', text: rt.text, checked: !!data.checked, depth }, rt.links));
      recurse();
      return;
    case 'toggle':
      out.push(withLinks({ type: 'toggle', text: rt.text, depth }, rt.links));
      recurse();
      return;
    case 'quote':
      out.push(withLinks({ type: 'quote', text: rt.text }, rt.links));
      recurse();
      return;
    case 'callout':
      out.push(withLinks({ type: 'callout', text: rt.text }, rt.links));
      recurse();
      return;
    case 'code':
      out.push({ type: 'code', text: rt.text });
      return;
    case 'divider':
      out.push({ type: 'divider', text: '' });
      return;
    case 'equation':
      out.push({ type: 'paragraph', text: cleanText(data.expression ?? '') });
      w.add('equation_text', 'Equations were imported as their source expression.', sid());
      return;
    case 'bookmark': case 'embed': case 'link_preview': {
      const cap = richTextPlain(data.caption).text;
      if (data.url && /^https?:\/\//i.test(data.url)) out.push({ type: 'paragraph', text: cap ? `${cap} ${data.url}` : data.url, links: [{ text: cap || data.url, url: data.url }] });
      return;
    }
    case 'table':
      w.add('table_flattened', 'Tables were imported as text rows ("cell | cell").', sid());
      for (const row of node.children ?? []) {
        const cells = ((row.table_row as { cells?: RichText[][] } | undefined)?.cells ?? []).map((c) => richTextPlain(c).text.trim());
        if (cells.some(Boolean)) out.push({ type: 'table_row', text: cells.join(' | ') });
      }
      return;
    case 'column_list': case 'column': case 'synced_block':
      for (const c of node.children ?? []) convert(c, depth, w, sid, out);
      return;
    case 'image': case 'video': case 'file': case 'pdf': case 'audio': {
      const f = blockFile(node);
      const cap = richTextPlain(data.caption).text.trim();
      out.push({ type: 'media_ref', text: cap, media: { kind: f?.kind ?? 'file', name: f?.name ?? null, external: !f?.hosted } });
      if (f?.hosted) w.add('file_url_expiring', 'Notion file links expire after an hour; files are copied into the Relay library during import (images and videos only).', sid());
      else w.add('unsupported_block', 'External file links are not imported as media.', sid());
      return;
    }
    case 'child_page':
      w.add('unsupported_block', 'Sub-pages are not imported; select them separately.', sid());
      return;
    case 'child_database':
      w.add('unsupported_block', 'Inline databases are not imported; select the data source separately.', sid());
      return;
    case 'unsupported': {
      const bt = (node.unsupported as { block_type?: string } | undefined)?.block_type ?? 'unknown';
      out.push({ type: 'unsupported', text: '', source_type: bt });
      w.add('unsupported_block', `Notion does not expose "${bt}" blocks through its API; they were skipped.`, sid());
      return;
    }
    default:
      out.push({ type: 'unsupported', text: '', source_type: t });
      w.add('unsupported_block', `"${t}" blocks are not imported.`, sid());
  }
}

/** Split a page's blocks into selectable sections at heading_1/heading_2. */
export function parseNotionBlocks(pageId: string, title: string, tree: TreeNode[], w: Warnings): NormalizedSection[] {
  const sections: NormalizedSection[] = [];
  let current = { id: `${pageId}:intro`, title, level: 0, blocks: [] as NormalizedBlock[] };
  const flush = () => {
    if (current.blocks.some((b) => b.text.trim() || b.type === 'divider' || b.type === 'media_ref')) {
      sections.push(finishSection({ ...current, tab_id: null, tab_title: null }));
    }
  };
  for (const node of tree) {
    if ((node.type === 'heading_1' || node.type === 'heading_2') && !node.in_trash) {
      const rt = richTextPlain((node[node.type] as { rich_text?: RichText[] }).rich_text);
      if (rt.text.trim()) {
        flush();
        current = { id: node.id, title: rt.text.trim().slice(0, 300), level: node.type === 'heading_1' ? 1 : 2, blocks: [] };
      }
    }
    convert(node, 0, w, () => current.id, current.blocks);
  }
  flush();
  return sections;
}

// ------------------------------------------------------------------ properties
export function pageTitle(page: NotionPage): string {
  for (const v of Object.values(page.properties ?? {})) {
    if (v.type === 'title') return cleanText(richTextPlain(v.title as RichText[]).text).trim() || 'Untitled';
  }
  return 'Untitled';
}

/** Normalized, comparable value of a property (used for mapping and writeback fingerprints). */
export function propertyValue(v: NotionPropertyValue | undefined): string | null {
  if (!v) return null;
  const raw = v[v.type] as unknown;
  switch (v.type) {
    case 'title': case 'rich_text': return cleanText(richTextPlain(raw as RichText[]).text).trim() || null;
    case 'select': case 'status': return (raw as { name?: string } | null)?.name ?? null;
    case 'multi_select': return ((raw as Array<{ name?: string }>) ?? []).map((o) => o.name).filter(Boolean).join(', ') || null;
    case 'date': { const d = raw as { start?: string; end?: string | null } | null; return d?.start ? (d.end ? `${d.start}/${d.end}` : d.start) : null; }
    case 'url': case 'email': case 'phone_number': return typeof raw === 'string' ? raw : null;
    case 'number': return typeof raw === 'number' ? String(raw) : null;
    case 'checkbox': return raw ? 'true' : 'false';
    case 'unique_id': { const u = raw as { prefix?: string | null; number?: number }; return u?.number !== undefined ? `${u.prefix ? `${u.prefix}-` : ''}${u.number}` : null; }
    case 'formula': { const f = raw as { type?: string; string?: string; number?: number; boolean?: boolean; date?: { start?: string } }; return f?.type === 'string' ? f.string ?? null : f?.type === 'number' ? String(f.number) : f?.type === 'boolean' ? String(f.boolean) : f?.date?.start ?? null; }
    case 'people': return ((raw as Array<{ name?: string }>) ?? []).map((p) => p.name).filter(Boolean).join(', ') || null;
    default: return null;
  }
}

export function propertyFingerprint(v: NotionPropertyValue | undefined): string {
  return sha256Hex(stableStringify({ type: v?.type ?? null, value: propertyValue(v) }));
}

/** Property types each mapping field accepts. */
export const MAPPABLE_TYPES: Record<string, readonly string[]> = {
  title: ['title', 'rich_text'],
  body: ['rich_text'],
  campaign: ['select', 'multi_select', 'rich_text', 'status'],
  target_date: ['date'],
  status: ['status', 'select'],
  external_ref: ['unique_id', 'rich_text', 'url', 'number', 'formula', 'title'],
};

export const WRITEBACK_TYPES: Record<string, readonly string[]> = {
  status: ['status', 'select', 'rich_text'],
  scheduled_time: ['date', 'rich_text'],
  post_url: ['url', 'rich_text'],
};

/** Notion property payload for a field-scoped writeback (ONLY this property is sent). */
export function writebackPayload(type: string, value: string | null): unknown {
  switch (type) {
    case 'status': return { status: value ? { name: value } : null };
    case 'select': return { select: value ? { name: value } : null };
    case 'date': return { date: value ? { start: value } : null };
    case 'url': return { url: value };
    default: return { rich_text: value ? [{ type: 'text', text: { content: value.slice(0, 2000) } }] : [] };
  }
}

/** The value Notion would report after a successful writeback (for fingerprint comparison). */
export function simulatedProperty(id: string, type: string, value: string | null): NotionPropertyValue {
  const payload = writebackPayload(type, value) as Record<string, unknown>;
  const v = payload[type === 'status' || type === 'select' || type === 'date' || type === 'url' ? type : 'rich_text'];
  if (type === 'rich_text' || !['status', 'select', 'date', 'url'].includes(type)) {
    return { id, type: 'rich_text', rich_text: value ? [{ plain_text: value }] : [] };
  }
  return { id, type, [type]: v };
}
