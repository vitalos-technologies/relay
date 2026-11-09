// Docs check (HC): validates content/help against the schema and the app. Run with `node scripts/docs-check.mjs`
// (CI runs it too). Checks: front matter schema, sections/folders, audiences, headings, internal links (articles, anchors,
// app routes), images (exist, alt text), related slugs, every <HelpLink slug> / helpArticleHref('…') in the app, links to
// help articles hard-coded in app code, unsafe link schemes, and secret / private-data patterns.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { findRawLinkTargets, isAllowedHref } from './markdown.js';
import { readHelpLibrary, renderArticle, type HelpArticle, type HelpLibrary, type HelpProblem } from './library.js';
import { HELP_AUDIENCES, isHelpSection } from './schema.js';

export interface DocsCheckResult {
  problems: HelpProblem[];
  stats: { articles: number; bySection: Record<string, number>; byAudience: Record<string, number>; helpLinks: number; appRoutes: number };
  helpLinks: Array<{ file: string; line: number; slug: string; section?: string; anchor?: string }>;
}

// ------------------------------------------------------------------ app routes
/** URL patterns of every page and route handler under apps/web/app (route groups removed, [x] = one segment). */
export function appRoutePatterns(appDir: string): RegExp[] {
  const out: RegExp[] = [];
  const walk = (dir: string, segs: string[]) => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    if (names.some((n) => /^(page|route)\.(tsx?|jsx?)$/.test(n))) {
      const parts = segs.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'));
      const re = parts.map((s) => (/^\[\[\.\.\..+\]\]$/.test(s) ? '(?:/.*)?' : /^\[\.\.\..+\]$/.test(s) ? '/.+' : /^\[.+\]$/.test(s) ? '/[^/]+' : `/${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)).join('');
      out.push(new RegExp(`^${re || '/'}$`));
    }
    for (const n of names) {
      if (n.startsWith('_') || n.startsWith('.') || n === 'node_modules') continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p, [...segs, n]);
    }
  };
  walk(appDir, []);
  return out;
}

// ------------------------------------------------------------------ secrets / private data
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/, 'private key'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/, 'GitHub token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/, 'API key'],
  [/\bsk-(proj-)?[A-Za-z0-9]{32,}\b/, 'API key'],
  [/\b(sk|rk|pk|whsec)_(live|test)_[A-Za-z0-9]{16,}\b/, 'Stripe key'],
  [/\bEAA[A-Za-z0-9]{40,}\b/, 'Meta access token'],
  [/\b[0-9]{8,10}:AA[A-Za-z0-9_-]{33}\b/, 'Telegram bot token'],
  [/\bsl_live_[a-z0-9]{12}_[a-f0-9]{64}\b/, 'Relay API key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\b/, 'JWT'],
  [/\b[a-z]+:\/\/[^\s:/@]+:[^\s:/@]{3,}@/i, 'credentials in a URL'],
  [/\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/, 'private IP address'],
  // Hostnames only (in a URL/after @, or with 3+ labels), so identifiers like `comments.internal` don't match.
  [/(?:[a-z]+:\/\/|@)(?!host\.docker\.internal)[a-z0-9.-]+\.(?:internal|intranet|corp|lan)\b|\b(?!host\.docker\.internal)[a-z0-9-]+\.[a-z0-9-]+\.(?:internal|intranet|corp|lan)\b/i, 'internal hostname'],
  [/docs\/runbooks\//, 'link to an operational runbook (runbooks are repo-only, never Help Centre content)'],
];
/** Documented local-only development values and obvious placeholders (same idea as scripts/secret-scan.sh). */
const PLACEHOLDER = /local-only|example|placeholder|change-?me|<[^>]+>|\$\{|:password@|:\*+@|xxxx/i;
const ALLOWED_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|[a-z0-9-]+\.example|[a-z0-9-]+\.test|example|test|invalid|localhost)$/i;

function secretProblems(file: string, source: string): HelpProblem[] {
  const out: HelpProblem[] = [];
  const lines = source.split('\n');
  lines.forEach((l, i) => {
    for (const [re, what] of SECRET_PATTERNS) if (re.test(l) && !PLACEHOLDER.test(l.match(re)![0])) out.push({ file, line: i + 1, message: `looks like ${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what}; use a placeholder (e.g. <your-token>, example.com)`, level: 'error' });
    for (const m of l.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) {
      if (!ALLOWED_EMAIL_DOMAIN.test(m[1]!)) out.push({ file, line: i + 1, message: `email address "${m[0]}" — use example.com or *.test addresses only`, level: 'error' });
    }
  });
  return out;
}

// ------------------------------------------------------------------ app code: HelpLink usages
const CODE_EXT = /\.(tsx?|jsx?)$/;
function listCode(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (n === 'node_modules' || n === '.next' || n.startsWith('.')) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else if (CODE_EXT.test(n)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** `<HelpLink slug="x">`, `helpArticleHref('x')` and literal '/help/<section>/<slug>' strings in app code. */
export function scanHelpLinks(webDir: string, repoRoot: string): { links: Array<{ file: string; line: number; slug: string; section?: string; anchor?: string }>; problems: HelpProblem[] } {
  const links: Array<{ file: string; line: number; slug: string; section?: string; anchor?: string }> = [];
  const problems: HelpProblem[] = [];
  for (const abs of listCode(webDir)) {
    const file = relative(repoRoot, abs).split(sep).join('/');
    if (file.includes('/components/help/help-link.')) continue; // the component's own definition
    const src = readFileSync(abs, 'utf8');
    const lineOf = (idx: number) => src.slice(0, idx).split('\n').length;
    for (const m of src.matchAll(/<HelpLink\b([^>]*?)\/?>/gs)) {
      const attrs = m[1]!;
      const lit = /\bslug=(?:"([^"]+)"|'([^']+)'|\{\s*["'`]([^"'`$]+)["'`]\s*\})/.exec(attrs);
      const anchor = /\banchor=(?:"([^"]+)"|'([^']+)')/.exec(attrs);
      if (lit) links.push({ file, line: lineOf(m.index!), slug: (lit[1] ?? lit[2] ?? lit[3])!, anchor: anchor ? (anchor[1] ?? anchor[2]) : undefined });
      else if (/\bhref=/.test(attrs)) continue; // href built with helpArticleHref('…'), which is scanned below
      else problems.push({ file, line: lineOf(m.index!), message: '<HelpLink> needs a literal slug="…" (or an href from helpArticleHref with a literal slug) so the docs check can verify it', level: 'error' });
    }
    for (const m of src.matchAll(/helpArticleHref\(\s*(?:["'`]([^"'`$]+)["'`])?(?:\s*,\s*["'`]([^"'`$]+)["'`])?/g)) {
      if (m[1]) links.push({ file, line: lineOf(m.index!), slug: m[1], anchor: m[2] });
      else problems.push({ file, line: lineOf(m.index!), message: 'helpArticleHref() needs a literal slug', level: 'error' });
    }
    for (const m of src.matchAll(/["'`]\/help\/([a-z0-9-]+)\/([a-z0-9-]+)(?:#([a-z0-9-]+))?["'`]/g)) {
      if (!isHelpSection(m[1]!) && m[1] !== 'article') continue; // /help/requests/…, /help/contact etc. are V4 routes
      links.push({ file, line: lineOf(m.index!), slug: m[2]!, section: m[1] === 'article' ? undefined : m[1], anchor: m[3] });
    }
  }
  return { links, problems };
}

// ------------------------------------------------------------------ article checks
function checkArticle(lib: HelpLibrary, a: HelpArticle, ctx: { routes: RegExp[]; publicDir: string }): HelpProblem[] {
  const out: HelpProblem[] = [];
  const P = (line: number, message: string, level: 'error' | 'warning' = 'error') => out.push({ file: a.file, line, message, level });
  const r = renderArticle(a);
  if (!a.body.trim() || r.text.length < 40) P(a.bodyLine, 'article body is empty or too short');

  // Headings: no H1 (title is front matter), no skipped levels.
  let prev = 1;
  const bodyLines = a.body.split('\n');
  const headingLine = (text: string) => { const i = bodyLines.findIndex((l) => /^#{1,6}\s/.test(l) && l.includes(text)); return i < 0 ? a.bodyLine : a.bodyLine + i; };
  for (const h of r.headings) {
    if (h.level === 1) P(headingLine(h.text), `remove the "# ${h.text}" heading — the page title comes from front matter; start at ##`);
    else if (h.level > prev + 1) P(headingLine(h.text), `heading "${h.text}" skips a level (h${prev} → h${h.level})`);
    prev = h.level;
  }

  // Unsafe / unsupported link targets (markdown-it drops them, so read the source).
  for (const l of findRawLinkTargets(a.body)) {
    if (!isAllowedHref(l.href)) P(a.bodyLine + l.line - 1, `link "${l.href}" is not allowed — use /help/<section>/<slug>, an app path, https://… or mailto:`);
  }

  const anchorsOf = (t: HelpArticle) => new Set(renderArticle(t).headings.map((h) => h.id));
  for (const l of r.links) {
    const href = l.href.trim();
    if (href.startsWith('#')) {
      if (!anchorsOf(a).has(href.slice(1))) P(l.line, `anchor "${href}" doesn't match a heading in this article`);
      continue;
    }
    if (/^https?:\/\//i.test(href)) { if (/^http:\/\//i.test(href)) P(l.line, `use https:// for "${href}"`, 'warning'); continue; }
    if (/^mailto:/i.test(href)) continue;
    if (!href.startsWith('/')) continue; // refused above
    const [pathPart, hash] = href.split('#') as [string, string | undefined];
    const path = pathPart.split('?')[0]!.replace(/\/+$/, '') || '/';
    if (path.startsWith('/help/img/')) {
      if (!existsSync(join(ctx.publicDir, path))) P(l.line, `linked file "${path}" doesn't exist in apps/web/public`);
      continue;
    }
    const m = /^\/help\/([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(path);
    if (m && isHelpSection(m[1]!)) {
      const t = lib.bySlug.get(m[2]!);
      if (!t) { P(l.line, `link to missing article "${m[2]}"`); continue; }
      if (t.section !== m[1]) { P(l.line, `article "${m[2]}" is in "${t.section}", not "${m[1]}" — link /help/${t.section}/${t.slug}`); continue; }
      if (hash && !anchorsOf(t).has(hash)) P(l.line, `anchor "#${hash}" doesn't match a heading in "${t.slug}"`);
      if (t.audience === 'admin' && a.audience !== 'admin') P(l.line, `links to admin-only article "${t.slug}" from a ${a.audience} article (readers without admin rights won't be able to open it)`, 'warning');
      continue;
    }
    const sec = /^\/help\/([a-z0-9-]+)$/.exec(path);
    if (sec && isHelpSection(sec[1]!)) continue;
    if (!ctx.routes.some((re) => re.test(path))) P(l.line, `link "${path}" doesn't match a page in the app or a help article`);
  }

  for (const img of r.images) {
    if (!img.alt.trim()) P(img.line, `image "${img.src}" needs alt text`);
    if (!img.src.startsWith('/help/img/')) { P(img.line, `image "${img.src}" must live under /help/img/<section>/ (apps/web/public/help/img)`); continue; }
    if (!existsSync(join(ctx.publicDir, img.src.split('?')[0]!))) P(img.line, `image "${img.src}" doesn't exist in apps/web/public`);
  }

  for (const s of a.related) {
    if (s === a.slug) P(1, '"related" lists the article itself');
    else if (!lib.bySlug.has(s)) P(1, `"related" slug "${s}" doesn't exist`);
  }
  return out;
}

export function runDocsCheck(repoRoot: string): DocsCheckResult {
  const contentDir = join(repoRoot, 'content', 'help');
  const webDir = join(repoRoot, 'apps', 'web');
  const publicDir = join(webDir, 'public');
  const lib = readHelpLibrary(contentDir);
  const problems: HelpProblem[] = lib.problems.map((p) => ({ ...p, file: `content/help/${p.file}` }));
  const routes = appRoutePatterns(join(webDir, 'app'));
  const prefix = (ps: HelpProblem[]) => ps.map((p) => ({ ...p, file: `content/help/${p.file}` }));

  if (!existsSync(contentDir)) problems.push({ file: 'content/help', line: 1, message: 'content/help does not exist', level: 'error' });
  else {
    for (const d of readdirSync(contentDir)) {
      const p = join(contentDir, d);
      if (statSync(p).isDirectory() && !d.startsWith('_') && !d.startsWith('.') && !isHelpSection(d)) {
        problems.push({ file: `content/help/${d}`, line: 1, message: `"${d}" is not a Help Centre section folder`, level: 'error' });
      }
    }
    if (!lib.bySlug.has('glossary')) problems.push({ file: 'content/help/glossary.md', line: 1, message: 'glossary.md is missing', level: 'warning' });
  }

  for (const a of lib.articles) {
    problems.push(...prefix(checkArticle(lib, a, { routes, publicDir })));
    problems.push(...prefix(secretProblems(a.file, readFileSync(join(contentDir, a.file), 'utf8'))));
  }
  // Files that failed to parse still get the secret scan.
  for (const p of new Set(lib.problems.map((x) => x.file))) {
    if (!lib.articles.some((a) => a.file === p) && existsSync(join(contentDir, p))) problems.push(...prefix(secretProblems(p, readFileSync(join(contentDir, p), 'utf8'))));
  }

  const scan = scanHelpLinks(webDir, repoRoot);
  problems.push(...scan.problems);
  for (const l of scan.links) {
    const a = lib.bySlug.get(l.slug);
    if (!a) problems.push({ file: l.file, line: l.line, message: `help link to missing article "${l.slug}"`, level: 'error' });
    else if (l.section && a.section !== l.section) problems.push({ file: l.file, line: l.line, message: `help link /help/${l.section}/${l.slug}: the article is in "${a.section}"`, level: 'error' });
    else if (l.anchor && !renderArticle(a).headings.some((h) => h.id === l.anchor)) problems.push({ file: l.file, line: l.line, message: `help link anchor "#${l.anchor}" doesn't match a heading in "${l.slug}"`, level: 'error' });
  }

  const bySection: Record<string, number> = {};
  const byAudience: Record<string, number> = Object.fromEntries(HELP_AUDIENCES.map((x) => [x, 0]));
  for (const a of lib.articles) { bySection[a.section] = (bySection[a.section] ?? 0) + 1; byAudience[a.audience] = (byAudience[a.audience] ?? 0) + 1; }
  problems.sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line);
  return { problems, stats: { articles: lib.articles.length, bySection, byAudience, helpLinks: scan.links.length, appRoutes: routes.length }, helpLinks: scan.links };
}
