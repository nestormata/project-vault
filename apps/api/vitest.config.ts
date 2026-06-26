import { mergeConfig } from 'vitest/config'
import { baseVitestConfig } from '@project-vault/tsconfig/vitest.base'

export default mergeConfig(baseVitestConfig, {
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      // Only count coverage for files directly tested in Story 1.1+
      // (boss.ts, events.ts stubs covered in later stories)
      include: [
        'src/routes/health.ts',
        'src/routes/metrics.ts',
        'src/app.ts',
        'src/lib/errors.ts',
        'src/lib/shutdown.ts',
        'src/modules/vault/key-service.ts',
        'src/modules/vault/routes.ts',
        'src/modules/vault/schema.ts',
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
