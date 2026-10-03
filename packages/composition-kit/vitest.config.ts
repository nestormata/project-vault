import { defineConfig } from 'vitest/config'

// Self-contained like extension-api's: the kit is published for Node >=20, so its own test runner
// must not depend on a workspace package's `.ts` export.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // An explicit include: a new file with no entry here silently reports 0% to Sonar.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'html', 'clover', 'json', 'lcov'],
      reportOnFailure: true,
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
})
