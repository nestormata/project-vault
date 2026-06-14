import { baseRules, secretsRules } from '@project-vault/eslint-config'

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/.stryker-tmp/**'],
  },
  ...baseRules,
  ...secretsRules,
]
