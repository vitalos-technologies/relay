#!/usr/bin/env node
// Downloadable documentation bundle (HC): static HTML of the Help Centre (content/help) as a zip.
//   node scripts/docs-bundle.mjs                       → dist/help/relay-help-<version>.zip (public, user, admin, developer)
//   node scripts/docs-bundle.mjs --audience public,user --out /tmp/x.zip
//   node scripts/docs-bundle.mjs --dir dist/help/html  also write the unzipped HTML folder
// Operational runbooks (docs/runbooks) are never read. The app serves the same bundle, filtered to the viewer's
// audiences, at GET /api/help/bundle (signed-in only).
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tsImport } from 'tsx/esm/api';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

const { readHelpLibrary } = await tsImport('../packages/services/src/help/library.ts', import.meta.url);
const { buildHelpBundle, zipFiles, bundleFileName } = await tsImport('../packages/services/src/help/bundle.ts', import.meta.url);
const { HELP_AUDIENCES, HELP_PRODUCT_VERSION } = await tsImport('../packages/services/src/help/schema.ts', import.meta.url);

const audiences = (opt('--audience') ?? HELP_AUDIENCES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
for (const a of audiences) if (!HELP_AUDIENCES.includes(a)) { console.error(`unknown audience "${a}" (use ${HELP_AUDIENCES.join(', ')})`); process.exit(2); }

const lib = readHelpLibrary(join(root, 'content', 'help'));
if (lib.problems.some((p) => p.level === 'error')) {
  console.error(`✖ content/help has errors — run node scripts/docs-check.mjs first`);
  process.exit(1);
}
const files = buildHelpBundle(lib, { audiences, publicDir: join(root, 'apps', 'web', 'public') });
const out = resolve(opt('--out') ?? join(root, 'dist', 'help', bundleFileName(HELP_PRODUCT_VERSION)));
mkdirSync(dirname(out), { recursive: true });
const zip = zipFiles(files);
writeFileSync(out, zip);
const dir = opt('--dir');
if (dir) for (const f of files) { const p = resolve(dir, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.data); }
const pages = files.filter((f) => f.path.endsWith('.html')).length - 1;
console.log(`✔ ${out} — ${pages} articles (${audiences.join(', ')}), ${files.length} files, ${(zip.length / 1024).toFixed(0)} KB`);
