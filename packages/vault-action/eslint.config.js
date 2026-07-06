import { baseRules } from '@project-vault/eslint-config'

export default [
  {
    ignores: ['dist/**', 'dist-ts/**', 'node_modules/**', 'coverage/**', '**/.stryker-tmp/**'],
  },
  ...baseRules,
]
