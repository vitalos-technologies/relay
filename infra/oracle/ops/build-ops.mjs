// Bundles the operator CLIs that production needs inside the image (no tsx at runtime):
//   ops/db-roles.mjs           — scripts/db-roles.ts (least-privilege login roles + infra/postgres/roles.sql grants)
//   ops/platform-operator.mjs  — scripts/platform-operator.ts (grant/revoke/list platform operators)
// Workspace packages are bundled; third-party packages (pg) stay external and resolve from the worker's
// production node_modules in the runtime image. Run from the repository root: node infra/oracle/ops/build-ops.mjs <outdir>
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(resolve('apps/worker/package.json'));
const { build } = require('esbuild');
const outdir = process.argv[2] ?? '/out/ops';

const externals = {
  name: 'externals',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@social-lite/') ? undefined : { path: args.path, external: true }));
  },
};

const common = {
  bundle: true, platform: 'node', target: 'node22', format: 'esm', outExtension: { '.js': '.mjs' }, outdir,
  resolveExtensions: ['.ts', '.js', '.mjs'], plugins: [externals], logLevel: 'info',
};

await build({
  ...common,
  entryPoints: { 'db-roles': 'scripts/db-roles.ts' },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

// platform-operator.ts only runs main() when argv[1] ends with "platform-operator.ts"; the banner keeps that guard true.
await build({
  ...common,
  entryPoints: { 'platform-operator': 'scripts/platform-operator.ts' },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url); process.argv[1] = 'platform-operator.ts';" },
});
