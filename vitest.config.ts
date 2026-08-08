import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const sharedExclude = ['**/node_modules/**', '**/dist/**', '**/build/**'];

const fromRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

const workspaceAliases = {
  '@nimbus/contracts': fromRoot('./packages/contracts/src/index.ts'),
  '@nimbus/test-utils': fromRoot('./packages/test-utils/src/index.ts'),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['{apps,packages}/*/src/**/*.{test,spec}.{ts,tsx}'],
          exclude: sharedExclude,
        },
      },
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['{apps,packages}/*/test/integration/**/*.{test,spec}.ts'],
          exclude: sharedExclude,
          passWithNoTests: true,
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
