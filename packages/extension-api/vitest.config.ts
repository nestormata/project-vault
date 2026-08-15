import { defineConfig } from 'vitest/config'

// Keep this config self-contained: Node 20 cannot load the shared package's `.ts` export
// through native ESM when Vitest resolves it from a dependency. The published extension API
// supports Node >=20, so its own test runner must work on Node 20 as well as Node 24.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'clover', 'json', 'lcov'],
      reportOnFailure: true,
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
})
