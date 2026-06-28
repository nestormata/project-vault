import {
  apiEnforcement,
  baseRules,
  secretsRules,
  svelteRules,
  webEnforcement,
} from './packages/eslint-config/index.js'

const rootSecretsRules = secretsRules.map((config) => ({
  ...config,
  files: [
    '*.{ts,js,mjs,cjs}',
    'scripts/**/*.{ts,js,mjs,cjs}',
    'apps/api/**/*.{ts,js,mjs,cjs}',
    'apps/web/**/*.{ts,js,mjs,cjs}',
    'packages/shared/**/*.{ts,js,mjs,cjs}',
  ],
}))

const rootApiEnforcement = apiEnforcement.map((config) => ({
  ...config,
  files: ['apps/api/src/**/*.ts', 'apps/api/src/**/*.js'],
}))

const rootWebEnforcement = webEnforcement.map((config) => ({
  ...config,
  files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.js', 'apps/web/src/**/*.svelte'],
}))

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.svelte-kit/**',
      '**/coverage/**',
      '**/.stryker-tmp/**',
      'packages/db/src/migrations/**',
    ],
  },
  ...baseRules,
  ...rootSecretsRules,
  ...svelteRules,
  ...rootApiEnforcement,
  ...rootWebEnforcement,
  {
    files: ['apps/web/src/**/*.test.ts'],
    rules: {
      'no-secrets/no-secrets': 'off',
      'sonarjs/no-duplicate-string': 'off',
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
]
