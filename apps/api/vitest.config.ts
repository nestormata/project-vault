import { mergeConfig } from 'vitest/config'
import { baseVitestConfig } from '@project-vault/tsconfig/vitest.base'

export default mergeConfig(baseVitestConfig, {
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup-env.ts'],
    fileParallelism: false,
    testTimeout: 45_000,
    hookTimeout: 45_000,
    coverage: {
      // Only count coverage for files directly tested in Story 1.1+
      // (boss.ts, events.ts stubs covered in later stories)
      include: [
        'src/routes/health.ts',
        'src/routes/metrics.ts',
        'src/app.ts',
        'src/lib/db-pool-metrics.ts',
        'src/lib/audit-or-fail-closed.ts',
        'src/lib/errors.ts',
        'src/lib/job-logging.ts',
        'src/lib/logger.ts',
        'src/lib/shutdown.ts',
        'src/lib/startup-logging.ts',
        'src/modules/platform-admin/orgs-routes.ts',
        'src/modules/platform-admin/route-common.ts',
        'src/modules/platform-admin/settings-routes.ts',
        'src/modules/platform-audit/maintenance-mode.ts',
        'src/modules/vault/key-service.ts',
        'src/modules/vault/routes.ts',
        'src/modules/vault/schema.ts',
        'src/plugins/http-metrics.ts',
        'src/plugins/structured-logging.ts',
        'src/plugins/vault-guard.ts',
        'src/plugins/redact-secrets.ts',
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
