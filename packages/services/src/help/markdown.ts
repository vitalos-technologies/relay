// Help Centre Markdown renderer (HC). markdown-it with raw HTML disabled (escaped, never rendered) and a strict link
// allow-list, so authored content can't inject markup or script URLs. Pure: no IO. Shared by the app, the offline bundle
// and the docs check (which uses the extracted links/images/headings).
import markdownit, { type MarkdownIt, type Token } from 'markdown-it';

/** Token attribute as text (markdown-it types allow numbers). */
const attr = (t: Token, name: string): string => { const v = t.attrGet(name); return v === null || v === undefined ? '' : String(v); };

export interface HelpHeading { level: number; id: string; text: string }
export interface HelpLinkRef { href: string; line: number; text: string }
export interface HelpImageRef { src: string; alt: string; line: number }
export interface RenderedHelp { html: string; headings: HelpHeading[]; text: string; links: HelpLinkRef[]; images: HelpImageRef[] }

export interface RenderOptions {
  /** Rewrite a link href; return null to render the link text without a link (e.g. app paths in the offline bundle). */
  rewriteLink?: (href: string) => string | null;
  /** Rewrite an image src (offline bundle uses relative paths). */
  rewriteImage?: (src: string) => string;
  /** Line offset added to reported line numbers (front matter length). */
  lineOffset?: number;
}

const ALLOWED_LINK = /^(?:\/(?!\/)|#|https?:\/\/|mailto:)/i;
export const isAllowedHref = (href: string) => ALLOWED_LINK.test(href.trim());

/** Heading id: lower-case, accents dropped, every run of other characters → "-". */
export function slugifyHeading(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
}

const CALLOUTS: Record<string, string> = { note: 'note', tip: 'tip', important: 'important', warning: 'warning', caution: 'warning' };

function inlineText(t: Token | undefined): string {
  if (!t) return '';
  if (!t.children) return t.content;
  return t.children.map((c: Token) => (c.type === 'text' || c.type === 'code_inline' ? c.content : c.type === 'softbreak' || c.type === 'hardbreak' ? ' ' : c.type === 'image' ? '' : '')).join('');
}

function createMd(): MarkdownIt {
  const md = markdownit({ html: false, linkify: false, typographer: false, breaks: false });
  md.validateLink = (url: string) => isAllowedHref(url);
  const r = md.renderer.rules;

  r.table_open = () => '<div class="help-table" role="region" tabindex="0" aria-label="Table"><table>\n';
  r.table_close = () => '</table></div>\n';

  r.link_open = (tokens, idx, options, e, self) => {
    const env = e as unknown as RenderEnv;
    const t = tokens[idx]!;
    const href = attr(t, 'href');
    const next = env.rewriteLink ? env.rewriteLink(href) : href;
    if (next === null) { env.unwrapped.add(closeIndex(tokens, idx)); return '<span class="help-path">'; }
    t.attrSet('href', next);
    if (/^https?:\/\//i.test(next)) { t.attrSet('target', '_blank'); t.attrSet('rel', 'noopener noreferrer'); t.attrJoin('class', 'external'); }
    return self.renderToken(tokens, idx, options);
  };
  r.link_close = (tokens, idx, options, e, self) => {
    const env = e as unknown as RenderEnv;
    if (env.unwrapped.has(idx)) return '</span>';
    const open = openToken(tokens, idx);
    const ext = open && /^https?:\/\//i.test(attr(open, 'href'));
    return (ext ? '<span class="sr-only"> (opens in a new tab)</span>' : '') + self.renderToken(tokens, idx, options);
  };
  r.image = (tokens, idx, _options, e) => {
    const env = e as unknown as RenderEnv;
    const t = tokens[idx]!;
    const src = attr(t, 'src');
    const alt = md.utils.escapeHtml(inlineText(t) || t.content);
    const out = env.rewriteImage ? env.rewriteImage(src) : src;
    const title = attr(t, 'title');
    return `<img src="${md.utils.escapeHtml(out)}" alt="${alt}"${title ? ` title="${md.utils.escapeHtml(title)}"` : ''} loading="lazy" decoding="async">`;
  };
  return md;
}

interface RenderEnv extends RenderOptions { unwrapped: Set<number>; [key: string | symbol]: unknown }

function closeIndex(tokens: Token[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    if (tokens[i]!.type === 'link_open') depth++;
    if (tokens[i]!.type === 'link_close' && --depth === 0) return i;
  }
  return -1;
}
function openToken(tokens: Token[], closeIdx: number): Token | null {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    if (tokens[i]!.type === 'link_close') depth++;
    if (tokens[i]!.type === 'link_open' && --depth === 0) return tokens[i]!;
  }
  return null;
}

let shared: MarkdownIt | null = null;
const mdi = () => (shared ??= createMd());

/** Render help Markdown → sanitised HTML plus the structure the app, search and check need. */
export function renderHelpMarkdown(body: string, opts: RenderOptions = {}): RenderedHelp {
  const md = mdi();
  const env: RenderEnv = { ...opts, unwrapped: new Set() };
  const tokens = md.parse(body, env);
  const headings: HelpHeading[] = [];
  const links: HelpLinkRef[] = [];
  const images: HelpImageRef[] = [];
  const text: string[] = [];
  const used = new Map<string, number>();
  const off = opts.lineOffset ?? 0;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === 'heading_open') {
      const label = inlineText(tokens[i + 1]);
      const base = slugifyHeading(label);
      const n = used.get(base) ?? 0;
      used.set(base, n + 1);
      const id = n ? `${base}-${n + 1}` : base;
      t.attrSet('id', id);
      headings.push({ level: Number(t.tag.slice(1)), id, text: label });
    }
    if (t.type === 'blockquote_open') {
      // Callout: "> **Note:** …" → <blockquote class="callout callout-note">
      const inline = tokens[i + 2];
      const kids = (inline?.type === 'inline' ? inline.children ?? [] : []).filter((k) => !(k.type === 'text' && k.content === ''));
      if (kids[0]?.type === 'strong_open' && kids[1]?.type === 'text') {
        const word = kids[1].content.replace(/:$/, '').trim().toLowerCase();
        if (CALLOUTS[word]) t.attrSet('class', `callout callout-${CALLOUTS[word]}`);
      }
    }
    if (t.type === 'inline') {
      const line = (t.map?.[0] ?? 0) + 1 + off;
      text.push(inlineText(t));
      const kids = t.children ?? [];
      for (let k = 0; k < kids.length; k++) {
        const c = kids[k]!;
        if (c.type === 'link_open') {
          let label = '';
          for (let j = k + 1; j < kids.length && kids[j]!.type !== 'link_close'; j++) label += kids[j]!.content;
          links.push({ href: attr(c, 'href'), line, text: label });
        }
        if (c.type === 'image') images.push({ src: attr(c, 'src'), alt: inlineText(c) || c.content, line });
      }
    }
    if (t.type === 'fence' || t.type === 'code_block') text.push(t.content);
  }
  const html = md.renderer.render(tokens, md.options, env);
  return { html, headings, text: text.join('\n').replace(/[ \t]+/g, ' ').trim(), links, images };
}

/** Links markdown-it refused (unsafe or unsupported schemes) stay as literal text; the check reports them from source. */
export function findRawLinkTargets(body: string): Array<{ href: string; line: number }> {
  const out: Array<{ href: string; line: number }> = [];
  const lines = body.split('\n');
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence) return;
    const re = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l.replace(/`[^`]*`/g, '')))) out.push({ href: m[1]!, line: i + 1 });
  });
  return out;
}
