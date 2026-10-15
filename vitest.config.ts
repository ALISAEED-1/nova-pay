import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test file boots its own embedded Postgres; on a small machine that
    // can take a while when several start at once.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
