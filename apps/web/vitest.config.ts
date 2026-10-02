import { vitestConfig } from './config/vitest.config.ts'

// PV-repository-only additions: the factory tests and their sources live outside the shipped src/.
export default vitestConfig({
  test: {
    include: ['config/**/*.test.ts'],
    coverage: { include: ['config/**/*.ts'], exclude: ['config/**/*.test.ts'] },
  },
})
