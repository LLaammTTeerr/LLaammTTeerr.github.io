import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Builds the site once before the suite runs, so the four test files
    // that read `dist/` cannot pass against a stale build. In the config
    // rather than the npm script: `vitest` run directly must build too.
    globalSetup: ['tests/global-setup.ts'],
  },
});
