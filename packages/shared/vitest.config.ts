import { mergeConfig } from 'vitest/config'
import { baseVitestConfig } from '@project-vault/tsconfig/vitest.base'

export default mergeConfig(baseVitestConfig, {
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      // Only count coverage for files that have tests in Story 1.1
      // Story 14.6: added auth.ts — its org-sso-domains additions were shipping with real
      // tests (auth.test.ts) but 0% *measured* coverage since this include list never grew
      // past the original Story 1.1 scope, silently excluding every schema file added since.
      include: ['src/schemas/api.ts', 'src/schemas/auth.ts'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
})
