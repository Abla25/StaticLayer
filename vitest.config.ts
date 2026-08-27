import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Protocol unit tests + deployment-core (DSE) tests + CLI config tests
    // + security integration tests + Phase 4: installer + demo tests.
    include: [
      'packages/protocol/test/**/*.test.ts',
      'packages/deployment-core/test/**/*.test.ts',
      'packages/cli/test/**/*.test.ts',
      'tests/**/*.test.ts',
      'apps/installer/test/**/*.test.ts',
      'apps/demo/test/**/*.test.ts',
    ],
    // Mining at difficulty 16 + workerd startup need generous timeouts.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    server: {
      deps: {
        inline: [/@staticlayer\/protocol/],
      },
    },
  },
});
