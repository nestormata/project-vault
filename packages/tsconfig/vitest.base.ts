import { defineConfig } from 'vitest/config'

export const baseVitestConfig = defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'clover', 'json', 'lcov'],
      // Vitest defaults this to false, which silently skips writing lcov.info whenever ANY
      // test in the run fails — not just on a coverage-threshold miss. In a monorepo package
      // with thousands of tests, a single unrelated failing test then blanks out SonarCloud's
      // coverage-on-new-code signal for the entire package (reported as 0%), even when the
      // changed files themselves are well covered. ci.yml's own "Upload coverage" step comments
      // already assume the report always gets written before failure — this makes that true.
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
