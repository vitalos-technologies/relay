// HC — Help Centre platform: front-matter schema, sanitising renderer, audience filtering, search, docs check, bundle.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audiencesFor, parseFrontMatter, parseYamlSubset, validateFrontMatter } from '@social-lite/services/help/schema';
import { renderHelpMarkdown, slugifyHeading } from '@social-lite/services/help/markdown';
import { articleFor, readHelpLibrary, readableArticles, relatedFor, searchHelp, sectionsFor, stem } from '@social-lite/services/help/library';
import { runDocsCheck, appRoutePatterns } from '@social-lite/services/help/check';
import { buildHelpBundle, crc32, unzipEntries, zipFiles } from '@social-lite/services/help/bundle';

const fm = (o: Record<string, string>) => `---\n${Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n`;
const base = { summary: 'One sentence about it.', status: 'available', product_version: '"2026-11"', reviewed: '2026-11-09' };
function article(section: string, slug: string, audience: string, extra: Record<string, string> = {}, body = '## Steps\n\n1. Open the page.\n2. Do the thing and check the outcome is right.\n') {
  return { path: `content/help/${section}/${slug}.md`, text: fm({ title: `Title for ${slug.replace(/-/g, ' ')}`, section, audience, ...base, ...extra }) + '\n' + body };
}

// Fake credentials built at runtime so no literal in this file matches scripts/secret-scan.sh.
const FAKE_STRIPE = ['sk', 'live', 'abcdefghijklmnopqrstuv'].join('_');
const FAKE_GITHUB = `${'gh'}p_${'abcdefghijklmnopqrstuvwxyz0123456789'}`;

let root: string;
function write(rel: string, text: string) { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'help-'));
  const files = [
    article('getting-started', 'what-is-relay', 'public', { related: '[schedule-a-post, admin-console-tour]', keywords: '[overview, intro]' }, '## What Relay does\n\nRelay helps a team plan and publish social posts. See [scheduling](/help/calendar-and-scheduling/schedule-a-post#pick-a-time) and [Planner](/planner).\n'),
    article('calendar-and-scheduling', 'schedule-a-post', 'user', { keywords: '[timezone]' }, '## Pick a time\n\nChoose a date and time zone when scheduling posts for each channel.\n\n## Common errors\n\nThe time is in the past.\n'),
    article('administration', 'admin-console-tour', 'admin', {}, '## Console\n\nThe admin console shows deliveries, approvals and the audit log for the workspace.\n'),
    article('developers', 'api-overview', 'developer', {}, '## Endpoints\n\nThe REST API lists posts with cursor pagination and idempotency keys.\n'),
    { path: 'content/help/glossary.md', text: fm({ title: 'Glossary', section: 'getting-started', audience: 'public', ...base }) + '\n## Terms\n\n**Channel** — one connected social account you publish to.\n' },
  ];
  for (const f of files) write(f.path, f.text);
  write('apps/web/app/(app)/planner/page.tsx', 'export default function P() { return null; }');
  write('apps/web/app/(app)/posts/[id]/page.tsx', 'export default function P() { return null; }');
  write('apps/web/components/x.tsx', `export const A = () => <><HelpLink slug="schedule-a-post" anchor="pick-a-time" /><HelpLink slug="missing-article" /><HelpLink slug="schedule-a-post" anchor="nope" /></>;\nconst h = helpArticleHref('api-overview');`);
  write('docs/runbooks/restore.md', '# Restore\n\nSECRET RUNBOOK');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('front matter (YAML subset + schema)', () => {
  it('parses inline lists, block lists of maps, quotes and comments', () => {
    const y = parseYamlSubset(`title: "Quoted: with colon"\nroles: [editor, publisher] # who\nsources:\n  - title: Meta docs\n    url: https://developers.facebook.com/docs/\n    verified: 2026-11-09\nrelated:\n  - a\n  - b\norder: 3`);
    expect(y).toEqual({ title: 'Quoted: with colon', roles: ['editor', 'publisher'], sources: [{ title: 'Meta docs', url: 'https://developers.facebook.com/docs/', verified: '2026-11-09' }], related: ['a', 'b'], order: 3 });
    expect(parseYamlSubset(`sources: [{ title: "X, Y", url: https://x.example/a, verified: 2026-01-02 }]`).sources).toEqual([{ title: 'X, Y', url: 'https://x.example/a', verified: '2026-01-02' }]);
    expect(() => parseYamlSubset('title: a\ntitle: b')).toThrow(/duplicate/);
  });

  it('reports every problem: required keys, enums, dates, folder/section, roles, unknown keys, sources', () => {
    const { data, errors } = validateFrontMatter(parseYamlSubset(
      `title: lower case\nsection: nowhere\naudience: staff\nstatus: done\nproduct_version: 2026\nreviewed: 2026-13-40\nroles: [wizard]\nsurprise: 1\nsources: [{ title: X, url: http://x.example }]`), { section: 'publishing' });
    expect(data).toBeNull();
    const all = errors.join('\n');
    for (const s of ['"summary" is required', 'sentence case', '"section" must be one of', 'but the file is in "publishing/"', '"audience" must be one of', '"status" must be one of',
      '"product_version"', '"reviewed" must be a date', 'unknown role "wizard"', 'unknown front-matter key "surprise"', 'https://', 'verified']) expect(all).toContain(s);
  });

  it('accepts a valid article and fills defaults', () => {
    const r = parseFrontMatter(article('publishing', 'x', 'user').text, { section: 'publishing' });
    expect(r.errors).toEqual([]);
    expect(r.data).toMatchObject({ section: 'publishing', audience: 'user', roles: [], related: [], sources: [], order: 100, keywords: [] });
    expect(parseFrontMatter('no front matter').errors[0]).toMatch(/missing front matter/);
  });
});

describe('renderer (sanitising)', () => {
  it('escapes raw HTML and drops unsafe link schemes', () => {
    const r = renderHelpMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=) [vb](vbscript:x) [file](file:///etc/passwd)\n\n![x](javascript:alert(1))');
    expect(r.html).not.toMatch(/<script|<img\s|<[^>]*\sonerror=|href="(javascript|data|vbscript|file):|src="javascript/i);
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.links).toEqual([]);
  });

  it('marks external links, ids headings (deduplicated), wraps tables, styles callouts', () => {
    const r = renderHelpMarkdown('## Common errors\n\n## Common errors\n\n### Café & más\n\n[Meta](https://developers.facebook.com/) [here](/help/publishing/x#a)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> **Warning:** Deleting a published post can\'t be undone.\n\n> plain quote');
    expect(r.headings.map((h) => h.id)).toEqual(['common-errors', 'common-errors-2', 'cafe-mas']);
    expect(r.html).toContain('<h2 id="common-errors">');
    expect(r.html).toMatch(/<a href="https:\/\/developers\.facebook\.com\/" target="_blank" rel="noopener noreferrer" class="external">Meta<span class="sr-only"> \(opens in a new tab\)<\/span><\/a>/);
    expect(r.html).toContain('<a href="/help/publishing/x#a">here</a>');
    expect(r.html).toContain('<div class="help-table" role="region" tabindex="0" aria-label="Table"><table>');
    expect(r.html).toContain('<blockquote class="callout callout-warning">');
    expect(r.html).toMatch(/<blockquote>\s*<p>plain quote/);
    expect(r.links.map((l) => l.href)).toEqual(['https://developers.facebook.com/', '/help/publishing/x#a']);
    expect(slugifyHeading('  What’s new? ')).toBe('what-s-new');
  });

  it('renders images lazily with escaped alt text, and rewrites/unwraps links for the bundle', () => {
    const r = renderHelpMarkdown('![The "Planner" week view](/help/img/calendar/week.png)\n\nOpen [Settings](/settings/security) or [Help](/help/getting-started/a).', {
      rewriteLink: (h) => (h.startsWith('/help/') ? '../getting-started/a.html' : null), rewriteImage: (s) => `..${s.slice(5)}`,
    });
    expect(r.html).toContain('<img src="../img/calendar/week.png" alt="The &quot;Planner&quot; week view" loading="lazy" decoding="async">');
    expect(r.html).toContain('<span class="help-path">Settings</span>');
    expect(r.html).toContain('<a href="../getting-started/a.html">Help</a>');
    expect(r.images).toEqual([{ src: '/help/img/calendar/week.png', alt: 'The "Planner" week view', line: 1 }]);
  });
});

describe('audiences and filtering (server-side rules)', () => {
  it('maps viewers to audiences', () => {
    expect(audiencesFor({ signedIn: false })).toEqual(['public']);
    expect(audiencesFor({ signedIn: true })).toEqual(['public', 'user', 'developer']);
    expect(audiencesFor({ signedIn: true, admin: true })).toContain('admin');
    expect(audiencesFor({ signedIn: true, platformStaff: true })).toContain('admin');
    expect(audiencesFor({ signedIn: true, guestOnly: true })).toEqual(['public']);
  });

  it('signed-out readers only get public articles; members never get admin articles', () => {
    const lib = readHelpLibrary(join(root, 'content/help'));
    expect(lib.problems).toEqual([]);
    expect(readableArticles(lib, ['public']).map((a) => a.slug).sort()).toEqual(['glossary', 'what-is-relay']);
    const member = audiencesFor({ signedIn: true });
    expect(readableArticles(lib, member).map((a) => a.slug)).not.toContain('admin-console-tour');
    expect(articleFor(lib, 'admin-console-tour', member)).toEqual({ article: null, hidden: true });
    expect(articleFor(lib, 'schedule-a-post', ['public'])).toEqual({ article: null, hidden: true });
    expect(articleFor(lib, 'nope', member)).toEqual({ article: null, hidden: false });
    expect(articleFor(lib, 'admin-console-tour', audiencesFor({ signedIn: true, admin: true })).article?.slug).toBe('admin-console-tour');
    expect(sectionsFor(lib, ['public']).find((s) => s.id === 'administration')!.articles).toEqual([]);
    // Related lists are filtered too: the public article relates to a member and an admin article.
    const intro = lib.bySlug.get('what-is-relay')!;
    expect(relatedFor(lib, intro, ['public']).map((a) => a.slug)).toEqual(['glossary']);
    expect(relatedFor(lib, intro, member).map((a) => a.slug)).toEqual(['schedule-a-post', 'glossary']);
  });

  it('search covers title, keywords, headings, summary and body — only what the reader may open', () => {
    const lib = readHelpLibrary(join(root, 'content/help'));
    const member = audiencesFor({ signedIn: true });
    expect(searchHelp(lib, member, 'scheduling posts')[0]!.slug).toBe('schedule-a-post');
    expect(searchHelp(lib, member, 'timezone').map((r) => r.slug)).toEqual(['schedule-a-post']); // keyword
    expect(searchHelp(lib, member, 'audit log')).toEqual([]); // admin-only body text never matches for members
    expect(searchHelp(lib, audiencesFor({ signedIn: true, admin: true }), 'audit log').map((r) => r.slug)).toEqual(['admin-console-tour']);
    expect(searchHelp(lib, ['public'], 'scheduling')).toEqual(searchHelp(lib, ['public'], 'scheduling').filter((r) => r.slug !== 'schedule-a-post'));
    expect(searchHelp(lib, ['public'], 'channel')[0]).toMatchObject({ slug: 'glossary', snippet: expect.stringContaining('Channel') });
    expect(searchHelp(lib, member, '   ')).toEqual([]);
    expect([stem('replies'), stem('posts'), stem('scheduling'), stem('class')]).toEqual(['reply', 'post', 'schedul', 'class']);
  });
});

describe('docs check', () => {
  it('maps app routes (groups dropped, dynamic segments)', () => {
    const routes = appRoutePatterns(join(root, 'apps/web/app'));
    expect(routes.some((r) => r.test('/planner'))).toBe(true);
    expect(routes.some((r) => r.test('/posts/123'))).toBe(true);
    expect(routes.some((r) => r.test('/nowhere'))).toBe(false);
  });

  it('passes the fixture except the missing HelpLink slug and anchor', () => {
    const r = runDocsCheck(root);
    expect(r.problems.filter((p) => p.level === 'error')).toEqual([
      { file: 'apps/web/components/x.tsx', line: 1, message: 'help link to missing article "missing-article"', level: 'error' },
      { file: 'apps/web/components/x.tsx', line: 1, message: 'help link anchor "#nope" doesn\'t match a heading in "schedule-a-post"', level: 'error' },
    ]);
    expect(r.stats).toMatchObject({ articles: 5, helpLinks: 4, byAudience: { public: 2, user: 1, admin: 1, developer: 1 } });
  });

  it('catches broken links, anchors, images, related slugs, headings, unsafe schemes and secrets', () => {
    write('content/help/publishing/bad-article.md', fm({ title: 'Bad article', section: 'publishing', audience: 'user', related: '[ghost, bad-article]', ...base }) + [
      '# Duplicate title', '', '#### Skipped level', '',
      'See [missing](/help/publishing/ghost), [wrong section](/help/publishing/schedule-a-post), [anchor](/help/calendar-and-scheduling/schedule-a-post#nope), [self](#nowhere),',
      '[app](/does-not-exist), [admin](/help/administration/admin-console-tour), [js](javascript:alert(1)), [rel](../x.md) and [runbook](https://github.example/docs/runbooks/x.md).',
      '', '![](/help/img/publishing/missing.png)', '', `Token ${FAKE_STRIPE} and ${FAKE_GITHUB} at 10.0.0.12 or db.prod.internal; mail jane@realcompany.co.uk.`,
      'Local value postgres://socialite:socialite-local-only@localhost:5432/x is fine; so is owner@demo.social-lite.test.',
    ].join('\n'));
    try {
      const msgs = runDocsCheck(root).problems.filter((p) => p.file.endsWith('bad-article.md')).map((p) => `${p.level}: ${p.message}`).join('\n');
      for (const s of ['remove the "# Duplicate title"', 'skips a level', 'link to missing article "ghost"', 'is in "calendar-and-scheduling", not "publishing"', 'anchor "#nope"', 'anchor "#nowhere"',
        'link "/does-not-exist"', 'warning: links to admin-only article', 'link "javascript:alert(1" is not allowed', 'link "../x.md" is not allowed', 'needs alt text', "doesn't exist in apps/web/public",
        '"related" slug "ghost"', '"related" lists the article itself', 'Stripe key', 'GitHub token', 'private IP', 'internal hostname', 'jane@realcompany.co.uk', 'operational runbook']) expect(msgs).toContain(s);
      expect(msgs).not.toContain('credentials in a URL');
      expect(msgs).not.toContain('demo.social-lite.test');
    } finally { rmSync(join(root, 'content/help/publishing/bad-article.md')); }
  });

  it('reports duplicate slugs, stray folders and dynamic HelpLink slugs', () => {
    write('content/help/publishing/what-is-relay.md', article('publishing', 'what-is-relay', 'user').text);
    write('content/help/misc/x.md', article('publishing', 'x', 'user').text);
    write('apps/web/components/y.tsx', 'export const B = ({ s }: { s: string }) => <HelpLink slug={s} />;');
    try {
      const msgs = runDocsCheck(root).problems.map((p) => p.message).join('\n');
      expect(msgs).toContain('duplicate slug "what-is-relay"');
      expect(msgs).toContain('"misc" is not a Help Centre section folder');
      expect(msgs).toContain('<HelpLink> needs a literal slug');
    } finally {
      rmSync(join(root, 'content/help/publishing/what-is-relay.md')); rmSync(join(root, 'content/help/misc'), { recursive: true }); rmSync(join(root, 'apps/web/components/y.tsx'));
    }
  });
});

describe('offline bundle', () => {
  it('zips what the audiences allow, rewrites links, never includes runbooks', () => {
    const lib = readHelpLibrary(join(root, 'content/help'));
    const files = buildHelpBundle(lib, { audiences: ['public', 'user', 'developer'], publicDir: join(root, 'apps/web/public'), generatedAt: new Date('2026-11-09T12:00:00Z') });
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(['relay-help/assets/help.css', 'relay-help/calendar-and-scheduling/schedule-a-post.html', 'relay-help/developers/api-overview.html',
      'relay-help/getting-started/glossary.html', 'relay-help/getting-started/what-is-relay.html', 'relay-help/index.html']);
    const intro = files.find((f) => f.path.endsWith('what-is-relay.html'))!.data.toString();
    expect(intro).toContain('<a href="../calendar-and-scheduling/schedule-a-post.html#pick-a-time">scheduling</a>');
    expect(intro).toContain('<span class="help-path">Planner</span>'); // app screens aren't dead links offline
    expect(intro).not.toContain('admin-console-tour');
    const zip = zipFiles(files);
    const entries = unzipEntries(zip);
    expect(entries.map((e) => e.path).sort()).toEqual(paths);
    for (const e of entries) {
      const data = e.method === 8 ? inflateRawSync(e.data) : e.data;
      expect(data.length).toBe(e.size);
      expect(crc32(data)).toBe(e.crc);
    }
    expect(zip.toString('latin1')).not.toContain('SECRET RUNBOOK');
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});
