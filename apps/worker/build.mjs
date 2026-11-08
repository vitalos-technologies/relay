// Bundle the worker: workspace packages (TypeScript sources) are bundled; third-party
// dependencies stay external and are installed in the runtime image.
import { build } from 'esbuild';

const bundleWorkspace = {
  name: 'externals',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('@social-lite/')) return undefined;
      if (args.path.startsWith('node:')) return { path: args.path, external: true };
      return { path: args.path, external: true };
    });
  },
};

await build({
  entryPoints: { main: 'src/main.ts', migrate: '../../packages/db/src/cli.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  resolveExtensions: ['.ts', '.js', '.mjs'],
  plugins: [bundleWorkspace],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
