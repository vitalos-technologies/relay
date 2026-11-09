// Offline documentation bundle (HC): static HTML of the Help Centre articles for the given audiences, zipped. Used by
// scripts/docs-bundle.mjs (all four audiences) and GET /api/help/bundle (the signed-in viewer's audiences only).
// Only content/help is read — operational runbooks (docs/runbooks) are never part of it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { readableArticles, renderArticle, type HelpArticle, type HelpLibrary } from './library.js';
import { HELP_SECTIONS, HELP_STATUS_LABEL, type HelpAudience } from './schema.js';

export interface BundleFile { path: string; data: Buffer }
export interface BundleOptions { audiences: readonly HelpAudience[]; publicDir: string; generatedAt?: Date; root?: string }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const AUDIENCE_LABEL: Record<HelpAudience, string> = { public: 'Everyone', user: 'Members', admin: 'Workspace admins', developer: 'Developers' };
const fmtDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#121416;--muted:#5b6168;--border:#e3e5e7;--raised:#f5f6f7;--accent:#c2410c;--note:#eef4ff;--warn:#fff4e5}
@media (prefers-color-scheme:dark){:root{--bg:#121416;--fg:#ebedee;--muted:#a2a8ae;--border:#2a2e33;--raised:#1b1e22;--accent:#fd8a3c;--note:#16233a;--warn:#33240f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}header{border-bottom:1px solid var(--border);padding:12px 16px}header a{font-weight:600;text-decoration:none;color:var(--fg)}
main{max-width:760px;margin:0 auto;padding:24px 16px 64px}h1{font-size:1.75rem;line-height:1.25;margin:.5rem 0}h2{font-size:1.25rem;margin-top:2rem}h3{font-size:1.05rem}
.crumbs,.meta,.muted{color:var(--muted);font-size:.875rem}.crumbs a{color:var(--muted)}.summary{font-size:1.05rem;color:var(--muted)}
pre{background:var(--raised);padding:12px;border-radius:8px;overflow:auto}code{font-size:.9em}
.help-table{overflow-x:auto;margin:1rem 0}table{border-collapse:collapse;width:100%;font-size:.925rem}th,td{border:1px solid var(--border);padding:6px 10px;text-align:left;vertical-align:top}th{background:var(--raised)}
blockquote{margin:1rem 0;padding:10px 14px;border-left:3px solid var(--border);background:var(--raised);border-radius:6px}.callout-warning,.callout-important{background:var(--warn);border-color:#f59e0b}.callout-note,.callout-tip{background:var(--note);border-color:#3b82f6}
img{max-width:100%;height:auto;border:1px solid var(--border);border-radius:8px}.help-path{font-family:ui-monospace,monospace;font-size:.9em}
.badge{display:inline-block;border:1px solid var(--border);border-radius:999px;padding:0 8px;font-size:.75rem}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
ul.list{padding-left:1.1rem}section{margin-top:1.5rem}footer{border-top:1px solid var(--border);margin-top:2.5rem;padding-top:1rem}`;

function page(title: string, depth: number, body: string, generated: string): string {
  const up = depth ? '../'.repeat(depth) : '';
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Relay Help</title><link rel="stylesheet" href="${up}assets/help.css"></head>
<body><header><a href="${up}index.html">Relay Help</a> <span class="muted">· offline copy, ${esc(generated)}</span></header><main>${body}</main></body></html>\n`;
}

/** Build the bundle's files (paths relative to the zip root folder). */
export function buildHelpBundle(lib: HelpLibrary, opts: BundleOptions): BundleFile[] {
  const generatedAt = opts.generatedAt ?? new Date();
  const generated = generatedAt.toISOString().slice(0, 10);
  const root = opts.root ?? 'relay-help';
  const articles = readableArticles(lib, opts.audiences);
  const included = new Map(articles.map((a) => [a.slug, a]));
  const images = new Set<string>();
  const files: BundleFile[] = [];
  const put = (p: string, s: string | Buffer) => files.push({ path: `${root}/${p}`, data: typeof s === 'string' ? Buffer.from(s, 'utf8') : s });

  const rewriteLink = (href: string): string | null => {
    if (/^(https?:|mailto:|#)/i.test(href)) return href;
    const [path, hash] = href.split('#') as [string, string | undefined];
    const m = /^\/help\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/.exec(path);
    if (m) { const t = included.get(m[2]!); return t ? `../${t.section}/${t.slug}.html${hash ? `#${hash}` : ''}` : null; }
    const s = /^\/help\/([a-z0-9-]+)\/?$/.exec(path);
    if (s) return `../index.html#${s[1]}`;
    if (path.startsWith('/help/img/')) { images.add(path); return `../img/${path.slice('/help/img/'.length)}`; }
    return null; // app screens: shown as text (the path), not as a dead link
  };
  const rewriteImage = (src: string) => { if (src.startsWith('/help/img/')) { images.add(src); return `../img/${src.slice('/help/img/'.length)}`; } return src; };

  for (const a of articles) {
    const r = renderArticle(a, { rewriteLink, rewriteImage });
    const sec = HELP_SECTIONS.find((s) => s.id === a.section)!;
    const status = HELP_STATUS_LABEL[a.status];
    const related = a.related.map((s) => included.get(s)).filter((x): x is HelpArticle => !!x);
    const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="../index.html">Help</a> › <a href="../index.html#${sec.id}">${esc(sec.title)}</a></nav>
<h1>${esc(a.title)}</h1><p class="summary">${esc(a.summary)}</p>
<p class="meta">For: ${esc(AUDIENCE_LABEL[a.audience])}${a.roles.length ? ` · Roles: ${esc(a.roles.join(', '))}` : ''}${status ? ` · <span class="badge">${esc(status)}</span>` : ''}</p>
${r.html}
${related.length ? `<section><h2>Related articles</h2><ul class="list">${related.map((x) => `<li><a href="../${x.section}/${x.slug}.html">${esc(x.title)}</a></li>`).join('')}</ul></section>` : ''}
${a.sources.length ? `<section><h2>Sources</h2><ul class="list">${a.sources.map((s) => `<li><a href="${esc(s.url)}">${esc(s.title)}</a> <span class="muted">— last verified ${esc(fmtDate(s.verified))}</span></li>`).join('')}</ul></section>` : ''}
<footer class="meta">Relay ${esc(a.product_version)} · Reviewed ${esc(fmtDate(a.reviewed))}</footer>`;
    put(`${a.section}/${a.slug}.html`, page(a.title, 1, body, generated));
  }

  const index = HELP_SECTIONS.map((s) => {
    const list = articles.filter((a) => a.section === s.id);
    if (!list.length) return '';
    return `<section id="${s.id}"><h2>${esc(s.title)}</h2><p class="muted">${esc(s.description)}</p><ul class="list">${list.map((a) => `<li><a href="${a.section}/${a.slug}.html">${esc(a.title)}</a> — <span class="muted">${esc(a.summary)}</span></li>`).join('')}</ul></section>`;
  }).join('\n');
  const audiences = opts.audiences.map((x) => AUDIENCE_LABEL[x]).join(', ');
  put('index.html', page('Help Centre', 0, `<h1>Relay Help Centre</h1><p class="summary">Offline copy of ${articles.length} articles for: ${esc(audiences)}. Generated ${esc(generated)}; the Help Centre in the app is always the latest version.</p>${index}`, generated));
  put('assets/help.css', CSS);
  for (const src of [...images].sort()) {
    const abs = join(opts.publicDir, src);
    if (existsSync(abs)) put(`img/${src.slice('/help/img/'.length)}`, readFileSync(abs));
  }
  return files;
}

// ------------------------------------------------------------------ zip (deflate, no dependency)
let crcTable: Uint32Array | null = null;
export function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer (deflate or store per entry, UTF-8 names, no ZIP64 — bundles are a few MB). */
export function zipFiles(files: BundleFile[], at = new Date()): Buffer {
  const dosTime = ((at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2)) & 0xffff;
  const dosDate = (((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()) & 0xffff;
  const chunks: Buffer[] = []; const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, 'utf8');
    const deflated = deflateRawSync(f.data, { level: 9 });
    const useDeflate = deflated.length < f.data.length;
    const data = useDeflate ? deflated : f.data;
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt16LE(0, 30); cen.writeUInt16LE(0, 32); cen.writeUInt16LE(0, 34); cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38); cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

/** Read back a zip produced by zipFiles (tests). */
export function unzipEntries(zip: Buffer): Array<{ path: string; method: number; size: number; crc: number; data: Buffer }> {
  const out: Array<{ path: string; method: number; size: number; crc: number; data: Buffer }> = [];
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(eocd + 10); let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10); const crc = zip.readUInt32LE(p + 16); const csize = zip.readUInt32LE(p + 20); const size = zip.readUInt32LE(p + 24);
    const nlen = zip.readUInt16LE(p + 28); const xlen = zip.readUInt16LE(p + 30); const clen = zip.readUInt16LE(p + 32); const off = zip.readUInt32LE(p + 42);
    const path = zip.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = zip.readUInt16LE(off + 26); const lxlen = zip.readUInt16LE(off + 28);
    const data = zip.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    out.push({ path, method, size, crc, data: Buffer.from(data) });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

export const bundleFileName = (productVersion: string) => `relay-help-${productVersion}.zip`;
