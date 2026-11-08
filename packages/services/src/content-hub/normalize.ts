// Normalized document model shared by Google Docs and Notion imports: fingerprints, plain-text rendering for drafts,
// HTML/Markdown rendering for exports, warnings aggregation and a bounded line diff. Pure (no IO).
// Imported text is UNTRUSTED content: it is only ever rendered as text, never interpreted as instructions.
import { createHash } from 'node:crypto';
import type {
  ImportWarning, NormalizedBlock, NormalizedSection, SnapshotDiffDto, TextDiffLine,
} from '@social-lite/core/contracts/content-hub';
import { stableStringify } from '../idempotency.js';

export type { ImportWarning, NormalizedBlock, NormalizedSection };

export const sha256Hex = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');

export class Warnings {
  private readonly map = new Map<string, ImportWarning>();
  add(code: ImportWarning['code'], message: string, sectionId: string | null = null, n = 1): void {
    const key = `${code}|${sectionId ?? ''}|${message}`;
    const cur = this.map.get(key);
    if (cur) cur.count += n;
    else this.map.set(key, { code, message, count: n, section_id: sectionId });
  }
  list(): ImportWarning[] {
    return [...this.map.values()];
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f‪-‮⁦-⁩]/g;
/** Strip control and bidi-override characters (display spoofing) from untrusted text; keep \t \n. */
export function cleanText(s: string): string {
  return s.replace(/\u000b/g, '\n').replace(CONTROL, '');
}

export function wordCount(blocks: NormalizedBlock[]): number {
  return blocks.reduce((n, b) => n + (b.text.trim() ? b.text.trim().split(/\s+/).length : 0), 0);
}

export function finishSection(s: Omit<NormalizedSection, 'word_count'>): NormalizedSection {
  return { ...s, word_count: wordCount(s.blocks) };
}

/** Content fingerprint: stable over key order; independent of derived counts. */
export function fingerprintSections(title: string, sections: NormalizedSection[]): string {
  return sha256Hex(stableStringify({ title, sections: sections.map((s) => ({ id: s.id, title: s.title, tab: s.tab_id, level: s.level, blocks: s.blocks })) }));
}

function inlineLinks(b: NormalizedBlock): string {
  let text = b.text;
  for (const l of b.links ?? []) {
    if (!l.url || text.includes(l.url)) continue;
    // Keep links visible in plain text drafts: "label (https://…)".
    if (l.text && text.includes(l.text)) text = text.replace(l.text, `${l.text} (${l.url})`);
    else text = `${text} ${l.url}`.trim();
  }
  return text;
}

/** Plain text for a draft: headings kept as lines, list markers/indentation, links inline. */
export function blocksToText(blocks: NormalizedBlock[]): string {
  const out: string[] = [];
  const counters = new Map<number, number>();
  for (const b of blocks) {
    if (b.type !== 'list_item' || !b.ordered) counters.clear();
    const indent = '  '.repeat(Math.max(0, Math.min(b.depth ?? 0, 6)));
    const text = inlineLinks(b);
    switch (b.type) {
      case 'heading': out.push(text); break;
      case 'list_item': {
        if (b.ordered) {
          const d = b.depth ?? 0;
          for (const k of [...counters.keys()]) if (k > d) counters.delete(k);
          const n = (counters.get(d) ?? 0) + 1;
          counters.set(d, n);
          out.push(`${indent}${n}. ${text}`);
        } else out.push(`${indent}• ${text}`);
        break;
      }
      case 'todo': out.push(`${indent}${b.checked ? '☑' : '☐'} ${text}`); break;
      case 'quote': out.push(text.split('\n').map((l) => `> ${l}`).join('\n')); break;
      case 'divider': out.push('—'); break;
      case 'unsupported': break;
      case 'media_ref': break;
      default: if (text.trim()) out.push(`${indent}${text}`);
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function sectionText(s: NormalizedSection, opts: { includeTitle?: boolean } = {}): string {
  const body = blocksToText(s.blocks);
  const hasHeading = s.blocks[0]?.type === 'heading';
  return opts.includeTitle && s.title && !hasHeading ? `${s.title}\n\n${body}`.trim() : body;
}

export function excerpt(text: string, n = 240): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Minimal, escaped HTML (for Google Docs conversion on export). */
export function textToHtml(title: string, text: string): string {
  const paras = text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1>\n${paras}</body></html>`;
}

/** Plain text from (trusted, app-generated) HTML: tags stripped, entities decoded. Used for Notion page exports. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// ------------------------------------------------------------------ diff
const MAX_DIFF_CELLS = 2_000_000;
const MAX_DIFF_LINES = 400;

/** LCS line diff, bounded; falls back to prefix/suffix trimming + replace for very large inputs. */
export function diffLines(a: string[], b: string[]): { lines: TextDiffLine[]; truncated: boolean } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const out: TextDiffLine[] = a.slice(0, start).map((text) => ({ op: 'same' as const, text }));
  if (midA.length * midB.length > MAX_DIFF_CELLS) {
    out.push(...midA.map((text) => ({ op: 'remove' as const, text })), ...midB.map((text) => ({ op: 'add' as const, text })));
  } else {
    const n = midA.length;
    const m = midB.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = midA[i] === midB[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { out.push({ op: 'same', text: midA[i]! }); i++; j++; }
      else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ op: 'remove', text: midA[i]! }); i++; }
      else { out.push({ op: 'add', text: midB[j]! }); j++; }
    }
    while (i < n) out.push({ op: 'remove', text: midA[i++]! });
    while (j < m) out.push({ op: 'add', text: midB[j++]! });
  }
  out.push(...a.slice(endA).map((text) => ({ op: 'same' as const, text })));
  // Keep changed lines with one line of context; cap the size.
  const changed = (k: number) => out[k] !== undefined && out[k]!.op !== 'same';
  const keep = out.map((_, k) => changed(k) || changed(k - 1) || changed(k + 1));
  const compact = out.filter((_, k) => keep[k]);
  return { lines: compact.slice(0, MAX_DIFF_LINES), truncated: compact.length > MAX_DIFF_LINES };
}

export function diffSnapshots(
  from: { id: string; sections: NormalizedSection[] } | null, to: { id: string; sections: NormalizedSection[] },
): SnapshotDiffDto {
  const before = new Map((from?.sections ?? []).map((s) => [s.id, s]));
  const after = new Map(to.sections.map((s) => [s.id, s]));
  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const changedSections = [...after.keys()].filter((k) => before.has(k) && stableStringify(before.get(k)!.blocks) !== stableStringify(after.get(k)!.blocks));
  const textOf = (ss: NormalizedSection[]) => ss.flatMap((s) => [`## ${s.title}`, ...sectionText(s).split('\n')]);
  const { lines, truncated } = diffLines(textOf(from?.sections ?? []), textOf(to.sections));
  return {
    from_snapshot_id: from?.id ?? null, to_snapshot_id: to.id,
    changed: added.length > 0 || removed.length > 0 || changedSections.length > 0,
    sections_added: added, sections_removed: removed, sections_changed: changedSections, lines, truncated,
  };
}
