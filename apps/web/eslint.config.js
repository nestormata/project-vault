import { baseRules, secretsRules, svelteRules, webEnforcement } from '@project-vault/eslint-config'

export default [
  {
    ignores: [
      '.svelte-kit/**',
      'build/**',
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '**/.stryker-tmp/**',
    ],
  },
  ...baseRules,
  ...secretsRules,
  ...svelteRules,
  ...webEnforcement,
]
