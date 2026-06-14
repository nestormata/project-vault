import { baseRules } from '@project-vault/eslint-config'

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/migrations/**',
      'coverage/**',
      '**/.stryker-tmp/**',
    ],
  },
  ...baseRules,
]
