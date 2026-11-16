import { defineConfig } from 'vitest/config';

// Engine tests against a real Dovecot (CONDSTORE, QRESYNC, IDLE, MOVE):
// GreenMail, used by the server's integration tests, announces none of the
// synchronisation extensions. Requires a running Docker daemon.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__integration__/**/*.integration.test.ts'],
    globalSetup: ['src/__integration__/dovecot.setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
