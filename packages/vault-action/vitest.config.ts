import { mergeConfig } from 'vitest/config'
import { baseVitestConfig } from '@project-vault/tsconfig/vitest.base'

export default mergeConfig(baseVitestConfig, {
  test: {
    exclude: ['**/node_modules/**', 'dist/**', 'dist-ts/**'],
  },
})
