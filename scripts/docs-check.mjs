#!/usr/bin/env node
// Docs check (HC): validates the Help Centre source (content/help) and every contextual help link in the app.
//   node scripts/docs-check.mjs            human-readable report; exit 1 on errors
//   node scripts/docs-check.mjs --strict   warnings fail too
//   node scripts/docs-check.mjs --json     machine-readable result
// Schema and rules: packages/services/src/help/{schema,check}.ts (loaded through tsx, so there is one implementation).
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tsImport } from 'tsx/esm/api';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const { runDocsCheck } = await tsImport('../packages/services/src/help/check.ts', import.meta.url);
const r = runDocsCheck(root);
const errors = r.problems.filter((p) => p.level === 'error');
const warnings = r.problems.filter((p) => p.level === 'warning');

if (args.has('--json')) {
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
} else {
  for (const p of r.problems) console.log(`${p.level === 'error' ? '✖' : '⚠'} ${p.file}:${p.line}  ${p.message}`);
  const s = r.stats;
  console.log(`\n${s.articles} articles · ${Object.entries(s.byAudience).map(([k, v]) => `${k} ${v}`).join(' · ')} · ${s.helpLinks} in-app help links · ${s.appRoutes} app routes`);
  console.log(errors.length || (args.has('--strict') && warnings.length)
    ? `✖ docs check failed: ${errors.length} error(s), ${warnings.length} warning(s)`
    : `✔ docs check passed${warnings.length ? ` with ${warnings.length} warning(s)` : ''}`);
}
process.exit(errors.length || (args.has('--strict') && warnings.length) ? 1 : 0);
