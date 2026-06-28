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
  {
    files: ['src/**/*.test.ts'],
    rules: {
      'no-secrets/no-secrets': 'off',
      'sonarjs/no-duplicate-string': 'off',
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
]
