// Help Centre content library (HC): reads content/help/**.md, validates front matter, renders, filters by audience and
// searches. Server-only IO (node:fs); no database. Used by the app, scripts/docs-check.mjs, scripts/docs-bundle.mjs.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { renderHelpMarkdown, type RenderedHelp, type RenderOptions } from './markdown.js';
import {
  HELP_SECTIONS, SLUG_RE, canRead, parseFrontMatter, type HelpAudience, type HelpFrontMatter, type HelpSectionId,
} from './schema.js';

export interface HelpArticle extends HelpFrontMatter {
  slug: string;
  /** Path relative to the content root, e.g. "getting-started/what-is-relay.md". */
  file: string;
  href: string;
  body: string;
  bodyLine: number;
}
export interface HelpProblem { file: string; line: number; message: string; level: 'error' | 'warning' }
export interface HelpLibrary { root: string; articles: HelpArticle[]; bySlug: Map<string, HelpArticle>; problems: HelpProblem[]; loadedAt: number }

export const helpHref = (section: string, slug: string) => `/help/${section}/${slug}`;

/** content/help: HELP_CONTENT_DIR, else the first `content/help` found walking up from the working directory
 *  (repo root in scripts/tests, apps/web under `next start`, /app in the standalone image). */
export function helpContentDir(): string {
  const env = process.env.HELP_CONTENT_DIR;
  if (env) return resolve(env);
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const c = join(dir, 'content', 'help');
    if (existsSync(c)) return c;
    const up = resolve(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  return join(process.cwd(), 'content', 'help');
}

function listMarkdown(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries.sort()) {
      if (name.startsWith('_') || name.startsWith('.')) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.md') && name.toLowerCase() !== 'readme.md') out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Parse every article under `root`. Invalid files are reported in `problems` and left out of `articles`. */
export function readHelpLibrary(root = helpContentDir()): HelpLibrary {
  const problems: HelpProblem[] = [];
  const articles: HelpArticle[] = [];
  const bySlug = new Map<string, HelpArticle>();
  for (const abs of listMarkdown(root)) {
    const file = relative(root, abs).split(sep).join('/');
    const parts = file.split('/');
    const slug = parts[parts.length - 1]!.replace(/\.md$/, '');
    const folder = parts.length === 1 ? null : parts[0]!;
    if (parts.length > 2) { problems.push({ file, line: 1, message: 'articles live one level deep: content/help/<section>/<slug>.md', level: 'error' }); continue; }
    if (parts.length === 1 && slug !== 'glossary') { problems.push({ file, line: 1, message: 'only glossary.md may sit at the top level; move it into a section folder', level: 'error' }); continue; }
    if (!SLUG_RE.test(slug)) { problems.push({ file, line: 1, message: `file name "${slug}" is not a slug (lower-case words joined by "-")`, level: 'error' }); continue; }
    const source = readFileSync(abs, 'utf8');
    const parsed = parseFrontMatter(source, { section: folder ?? 'getting-started' });
    for (const e of parsed.errors) problems.push({ file, line: 1, message: e, level: 'error' });
    if (!parsed.data) continue;
    const prev = bySlug.get(slug);
    if (prev) { problems.push({ file, line: 1, message: `duplicate slug "${slug}" (also ${prev.file}); slugs are unique across sections`, level: 'error' }); continue; }
    const a: HelpArticle = { ...parsed.data, slug, file, href: helpHref(parsed.data.section, slug), body: parsed.body, bodyLine: parsed.bodyLine };
    articles.push(a);
    bySlug.set(slug, a);
  }
  const sectionIndex = new Map<string, number>(HELP_SECTIONS.map((s, i) => [s.id, i]));
  articles.sort((a, b) => (sectionIndex.get(a.section)! - sectionIndex.get(b.section)!) || a.order - b.order || a.title.localeCompare(b.title));
  return { root, articles, bySlug, problems, loadedAt: Date.now() };
}

// ------------------------------------------------------------------ cached library for the app
let cached: HelpLibrary | null = null;
const rendered = new WeakMap<HelpArticle, RenderedHelp>();
const DEV_TTL_MS = 2_000;

/** The app's library: read once in production (content ships with the build); re-read every 2 s elsewhere. */
export function helpLibrary(): HelpLibrary {
  const ttl = process.env.NODE_ENV === 'production' ? Infinity : DEV_TTL_MS;
  if (!cached || Date.now() - cached.loadedAt > ttl) cached = readHelpLibrary();
  return cached;
}
export function resetHelpLibraryCache(): void { cached = null; }

export function renderArticle(a: HelpArticle, opts?: RenderOptions): RenderedHelp {
  if (opts) return renderHelpMarkdown(a.body, { ...opts, lineOffset: a.bodyLine - 1 });
  let r = rendered.get(a);
  if (!r) { r = renderHelpMarkdown(a.body, { lineOffset: a.bodyLine - 1 }); rendered.set(a, r); }
  return r;
}

// ------------------------------------------------------------------ audience filtering
export function readableArticles(lib: HelpLibrary, audiences: readonly HelpAudience[]): HelpArticle[] {
  return lib.articles.filter((a) => canRead(audiences, a.audience));
}

/** The article if this viewer may read it. `hidden` = it exists but needs another audience (never its content). */
export function articleFor(lib: HelpLibrary, slug: string, audiences: readonly HelpAudience[]): { article: HelpArticle | null; hidden: boolean } {
  const a = lib.bySlug.get(slug);
  if (!a) return { article: null, hidden: false };
  return canRead(audiences, a.audience) ? { article: a, hidden: false } : { article: null, hidden: true };
}

export interface HelpSectionView { id: HelpSectionId; title: string; description: string; icon: string; articles: HelpArticle[] }
export function sectionsFor(lib: HelpLibrary, audiences: readonly HelpAudience[]): HelpSectionView[] {
  const visible = readableArticles(lib, audiences);
  return HELP_SECTIONS.map((s) => ({ ...s, articles: visible.filter((a) => a.section === s.id) }));
}

export function relatedFor(lib: HelpLibrary, a: HelpArticle, audiences: readonly HelpAudience[], max = 6): HelpArticle[] {
  const seen = new Set<string>([a.slug]);
  const out: HelpArticle[] = [];
  for (const slug of a.related) {
    const r = lib.bySlug.get(slug);
    if (r && !seen.has(r.slug) && canRead(audiences, r.audience)) { out.push(r); seen.add(r.slug); }
  }
  // Top up with neighbours from the same section so every page offers somewhere to go next.
  for (const r of lib.articles) {
    if (out.length >= Math.min(max, 3)) break;
    if (r.section === a.section && !seen.has(r.slug) && canRead(audiences, r.audience)) { out.push(r); seen.add(r.slug); }
  }
  return out.slice(0, max);
}

// ------------------------------------------------------------------ search
/** Lower-case, accents dropped, light English stemming (posts→post, scheduling→schedul, replies→reply). */
export function stem(word: string): string {
  let w = word.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}
export function tokenize(text: string): string[] {
  return (text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 || /\d/.test(w)).map(stem);
}

interface SearchDoc { title: string[]; keywords: string[]; headings: string[]; summary: string[]; body: Set<string>; text: string }
const docs = new WeakMap<HelpArticle, SearchDoc>();
function searchDoc(a: HelpArticle): SearchDoc {
  let d = docs.get(a);
  if (!d) {
    const r = renderArticle(a);
    d = { title: tokenize(a.title), keywords: tokenize(a.keywords.join(' ')), headings: tokenize(r.headings.map((h) => h.text).join(' ')),
      summary: tokenize(a.summary), body: new Set(tokenize(r.text)), text: r.text };
    docs.set(a, d);
  }
  return d;
}

const hit = (words: Iterable<string>, t: string) => { for (const w of words) if (w === t || (t.length >= 2 && w.startsWith(t))) return true; return false; };

export interface HelpSearchResult { slug: string; title: string; summary: string; href: string; section: string; sectionTitle: string; snippet: string; score: number }

function snippetFor(text: string, terms: string[]): string {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 20);
  const best = sentences.find((s) => terms.some((t) => tokenize(s).some((w) => w.startsWith(t))));
  if (!best) return '';
  return best.length > 180 ? `${best.slice(0, 177).trimEnd()}…` : best;
}

/** Ranked search over the articles this viewer may read. Every query term must match somewhere (title, keywords,
 *  headings, summary or body); titles and keywords weigh most. */
export function searchHelp(lib: HelpLibrary, audiences: readonly HelpAudience[], query: string, limit = 20): HelpSearchResult[] {
  const terms = [...new Set(tokenize(query))].slice(0, 8);
  if (!terms.length) return [];
  const out: HelpSearchResult[] = [];
  for (const a of readableArticles(lib, audiences)) {
    const d = searchDoc(a);
    let score = 0; let all = true;
    for (const t of terms) {
      let s = 0;
      if (hit(d.title, t)) s += 10;
      if (hit(d.keywords, t)) s += 8;
      if (hit(d.headings, t)) s += 4;
      if (hit(d.summary, t)) s += 3;
      if (hit(d.body, t)) s += 1;
      if (!s) { all = false; break; }
      score += s;
    }
    if (!all) continue;
    const phrase = query.trim().toLowerCase();
    if (phrase.length > 3 && a.title.toLowerCase().includes(phrase)) score += 15;
    const section = HELP_SECTIONS.find((s) => s.id === a.section)!;
    out.push({ slug: a.slug, title: a.title, summary: a.summary, href: a.href, section: a.section, sectionTitle: section.title, snippet: snippetFor(d.text, terms), score });
  }
  return out.sort((x, y) => y.score - x.score || x.title.localeCompare(y.title)).slice(0, limit);
}
