import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const alias = [
  // subpath imports (e.g. @social-lite/services/imports) map to src/<path>.ts
  { find: /^@social-lite\/(core|db|providers|services)\/(.+)$/, replacement: r('./packages') + '/$1/src/$2.ts' },
  { find: /^@social-lite\/(core|db|providers|services)$/, replacement: r('./packages') + '/$1/src/index.ts' },
];

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' } },
      { resolve: { alias }, test: { name: 'contracts', include: ['tests/contracts/**/*.test.ts'], environment: 'node' } },
      {
        resolve: { alias },
        test: {
          name: 'integration', include: ['tests/integration/**/*.test.ts'], environment: 'node',
          globalSetup: ['tests/integration/global-setup.ts'], pool: 'forks', poolOptions: { forks: { singleFork: true } }, testTimeout: 30_000, hookTimeout: 60_000,
        },
      },
    ],
  },
});
