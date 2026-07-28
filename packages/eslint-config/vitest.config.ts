import { defineConfig } from 'vitest/config'

// Deliberately does NOT import @project-vault/tsconfig/vitest.base (the repo's usual shared
// config) — tsconfig already depends on this package for its own eslint config, and importing
// it back here would create a workspace dependency cycle that breaks `turbo build`/`test`
// repo-wide. Coverage settings below are duplicated from that base on purpose, not drifted from.
export default defineConfig({
  test: {
    include: ['rules/**/*.test.js'],
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
      // Only no-error-schema-first-in-union.js and no-contiguous-allowed-roles.js have tests
      // today. no-bare-decrypt.js and no-bare-drizzle.js predate this package's test
      // infrastructure and are out of scope for this change — scoping coverage here avoids
      // claiming untested pre-existing files are covered, rather than lowering the repo's 80%
      // threshold for the whole package.
      include: ['rules/no-error-schema-first-in-union.js', 'rules/no-contiguous-allowed-roles.js'],
    },
  },
})
