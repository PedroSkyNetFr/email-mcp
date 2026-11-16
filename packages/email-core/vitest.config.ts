import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Dovecot tests need their container: run them with `pnpm test:integration`.
    exclude: ['src/__integration__/**'],
    testTimeout: 10_000,
  },
});
