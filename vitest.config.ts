import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The engine package is read from its sources, never from its compiled dist/:
// a test must exercise the code being edited, not the last build of it.
const coreSrc = fileURLToPath(new URL('./packages/email-core/src/', import.meta.url));
export const coreAlias = [
  { find: /^@pedroskynet\/email-core$/, replacement: `${coreSrc}index.ts` },
  { find: /^@pedroskynet\/email-core\/(.*)\.js$/, replacement: `${coreSrc}$1.ts` },
];

export default defineConfig({
  resolve: { alias: coreAlias },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'packages/email-core/src/**/*.test.ts'],
    exclude: ['src/__integration__/**'],
    reporters: ['default', 'junit', 'json'],
    outputFile: {
      junit: 'reports/test-results.xml',
      json: 'reports/test-results.json',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'packages/email-core/src/**/*.ts'],
      exclude: ['**/*.test.ts', 'src/main.ts'],
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: 'reports/coverage',
    },
    testTimeout: 10_000,
  },
});
