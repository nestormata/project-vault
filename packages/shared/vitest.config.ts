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
      // Story 18.2: same recurrence — added absolute-url.ts (utils/absolute-url.test.ts, 16
      // tests, real coverage) but this allowlist still didn't grow, so Sonar's new-code gate
      // saw 0% measured coverage on it and failed the PR. This manual-allowlist pattern keeps
      // recurring; apps/api's vitest.config.ts already solved the same problem with a truthful
      // `src/**/*.ts` contract (Story 10.4) — worth doing here too, as its own dedicated change
      // (broadening now would newly subject ~15 previously-excluded files to this package's 80%
      // aggregate threshold below, which needs its own verification pass, not a CI-fix drive-by).
      include: [
        'src/schemas/api.ts',
        'src/schemas/auth.ts',
        'src/utils/absolute-url.ts',
        'src/validation/rotation-cron-description.ts',
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
