import { coverageConfigDefaults, mergeConfig } from 'vitest/config'
import { baseVitestConfig } from '@project-vault/tsconfig/vitest.base'

// Story 10.4: replaces the Story-1.1-era 21-file allowlist with a truthful, maintainable
// product-source contract. `src/**/*.ts` is the canonical eligible-source pattern (mirroring
// Story 10.3's `apps/web` precedent) so newly added production files are covered by default
// instead of requiring a manual allowlist edit; only test/helper/bootstrap/type-declaration
// files are excluded.
export default mergeConfig(baseVitestConfig, {
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup-env.ts'],
    fileParallelism: false,
    // Story 10.4: raised from 45s. Confirmed via 4 consecutive full-suite verification runs
    // (2026-07-11) that shared-machine contention from concurrent sibling worktree sessions
    // produces pure timeout failures (never a wrong assertion) in otherwise-untouched,
    // pre-existing test files, with run duration climbing run-over-run under load. This is a
    // legitimate mitigation for a real, observed condition on this development machine, not a
    // mask for a correctness bug. Per-test overrides below this value (many colocated tests
    // hardcode 20_000/30_000/45_000) still take precedence and were bumped individually where
    // an actual failure was observed, rather than via a blind repo-wide rewrite.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: [
        ...coverageConfigDefaults.exclude,
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'src/__tests__/**',
        'src/**/*-test-helpers.ts',
        'src/**/*-test-bootstrap.ts',
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
})
