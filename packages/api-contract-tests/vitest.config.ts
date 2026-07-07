import { mergeConfig } from 'vitest/config'
import { baseVitestConfig } from '@project-vault/tsconfig/vitest.base'

export default mergeConfig(baseVitestConfig, {
  test: {
    include: ['src/**/*.test.ts'],
    // A single integration suite against one shared real Postgres instance and one real
    // Fastify app instance — not designed for parallel workers.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // This package is a black-box contract-conformance suite, not a unit-tested library of its
    // own business logic — its "coverage" is which OpenAPI operations it exercised (reported in
    // its own test output), not statement/branch coverage of its helper code. Matches
    // apps/web's precedent for a coverage-inapplicable package.
    coverage: {
      thresholds: {
        lines: 0,
        branches: 0,
        functions: 0,
        statements: 0,
      },
    },
  },
})
