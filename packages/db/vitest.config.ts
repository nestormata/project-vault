import { mergeConfig } from 'vitest/config'
import { baseVitestConfig } from '@project-vault/tsconfig/vitest.base'

export default mergeConfig(baseVitestConfig, {
  test: {
    include: ['src/**/*.test.ts'],
    // All tests here are integration tests against one shared real Postgres instance
    // with mutable state (orgs, RLS policies). check-rls-coverage.test.ts in particular
    // drops and recreates live RLS policies — running test files in parallel risks a
    // race with rls-isolation.test.ts or other suites touching the same tables.
    fileParallelism: false,
    coverage: {
      // Schema files are declarative table definitions with no branch logic —
      // excluded same as packages/db/src/migrations (see .jscpd.json rationale).
      include: ['src/index.ts', 'src/test-helpers.ts', 'src/check-rls-coverage.ts'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
})
