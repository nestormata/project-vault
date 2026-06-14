import { mergeConfig } from 'vitest/config'
import { baseVitestConfig } from '@project-vault/tsconfig/vitest.base'

export default mergeConfig(baseVitestConfig, {
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      // Only count coverage for files directly tested in Story 1.1
      // (boss.ts, events.ts, errors.ts stubs covered in Story 1.2+)
      include: ['src/routes/health.ts', 'src/routes/metrics.ts', 'src/app.ts'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
})
