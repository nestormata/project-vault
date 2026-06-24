// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  coverageAnalysis: 'perTest',
  ignoreStatic: true,
  // Initial threshold: 60% — ratchets to 80% after Epic 2 is complete
  // Initial scaffold correctly reports "no mutants found" (all Story 1.1 code is
  // infrastructure/stubs — business logic files that Stryker mutates are added in Story 1.2+)
  thresholds: {
    high: 80,
    low: 60,
    break: 60,
  },
  // Only mutate domain/business logic files (services, repositories, domain models)
  // Infrastructure, adapters, and stubs are excluded — they contain no domain logic
  // Story 1.2+ adds service files that Stryker will mutate
  mutate: [
    'apps/api/src/lib/pagination.ts',
    'apps/api/src/services/**/*.ts',
    'apps/api/src/domain/**/*.ts',
    'packages/db/src/repositories/**/*.ts',
    // Story 1.4: foundational RLS security layer — held to the ≥80% mutation
    // requirement regardless of the epic-wide 60% nightly gate.
    'packages/db/src/index.ts',
    'packages/db/src/test-helpers.ts',
    'packages/db/src/check-rls-coverage.ts',
    '!**/*.config.{js,ts,mjs}',
    '!**/migrations/**',
    '!**/*.d.ts',
    '!**/generated/**',
    '!**/*.test.ts',
    '!**/scripts/**',
  ],
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
}
