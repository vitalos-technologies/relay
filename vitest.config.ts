import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const alias = {
  '@social-lite/core': r('./packages/core/src/index.ts'),
  '@social-lite/db': r('./packages/db/src/index.ts'),
  '@social-lite/providers': r('./packages/providers/src/index.ts'),
  '@social-lite/services': r('./packages/services/src/index.ts'),
};

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
