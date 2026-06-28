import typescriptEslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import security from 'eslint-plugin-security'
import sonarjs from 'eslint-plugin-sonarjs'
import noSecrets from 'eslint-plugin-no-secrets'
import svelte from 'eslint-plugin-svelte'
import prettierConfig from 'eslint-config-prettier'
import { noBaredrizzle } from './rules/no-bare-drizzle.js'
import { noBareDecrypt } from './rules/no-bare-decrypt.js'

// Use the strict config rules from the plugin's legacy config set
// (flat/strict would require project-level type info which we skip for Story 1.1)
const strictRules = typescriptEslint.configs['strict']?.rules ?? {}

/** @type {import('eslint').Linter.FlatConfig[]} */
export const baseRules = [
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs'],
    plugins: {
      '@typescript-eslint': typescriptEslint,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      ...strictRules,
      // Allow underscore-prefixed variables as intentionally unused stubs
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs'],
    plugins: {
      sonarjs,
    },
    rules: {
      'sonarjs/cognitive-complexity': ['error', 15],
      'sonarjs/no-duplicate-string': 'error',
      'sonarjs/no-identical-functions': 'error',
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs'],
    rules: {
      complexity: ['error', 10],
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs'],
    plugins: {
      security,
    },
    rules: {
      ...security.configs.recommended.rules,
    },
  },
  prettierConfig,
]

/** @type {import('eslint').Linter.FlatConfig[]} */
export const secretsRules = [
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs'],
    plugins: {
      'no-secrets': noSecrets,
    },
    rules: {
      'no-secrets/no-secrets': [
        'error',
        {
          tolerance: 4.5,
          additionalRegexes: {
            UUID: '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
            HexHash: '[0-9a-f]{32,64}',
          },
        },
      ],
    },
  },
]

/** @type {import('eslint').Linter.FlatConfig[]} */
export const svelteRules = [
  // Use flat/recommended which includes the correct parser and processor config
  ...svelte.configs['flat/recommended'],
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: {
        extraFileExtensions: ['.svelte'],
        parser: tsParser,
      },
    },
  },
  {
    files: ['**/*.svelte'],
    rules: {
      'svelte/no-at-html-tags': 'error',
    },
  },
]

/** @type {import('eslint').Linter.FlatConfig[]} */
export const apiEnforcement = [
  {
    files: ['src/**/*.ts', 'src/**/*.js'],
    plugins: {
      'no-bare-drizzle': {
        rules: { 'no-bare-call': noBaredrizzle },
      },
      'no-bare-decrypt': {
        rules: { 'no-bare-call': noBareDecrypt },
      },
    },
    rules: {
      'no-bare-drizzle/no-bare-call': 'error',
      // no-bare-decrypt: block both decrypt and bootstrapDecrypt everywhere in the API
      // (bootstrapDecrypt is the re-exported alias; same security constraint applies)
      'no-bare-decrypt/no-bare-call': ['error', { blockedNames: ['decrypt', 'bootstrapDecrypt'] }],
    },
  },
  // Exception: vault key-service bootstrap is the sole permitted caller of bootstrapDecrypt
  // — it cannot use withSecret() because the module-level key isn't set yet during unseal.
  // (Only the rule options are overridden here — the plugin itself is registered once above;
  // ESLint flat config errors if the same plugin name is registered twice for overlapping files.)
  {
    files: ['src/modules/vault/key-service.ts'],
    rules: {
      'no-bare-decrypt/no-bare-call': [
        'error',
        { blockedNames: ['decrypt'], allowNames: ['bootstrapDecrypt'] },
      ],
    },
  },
]

/** @type {import('eslint').Linter.FlatConfig[]} */
export const webEnforcement = [
  {
    files: ['src/**/*.ts', 'src/**/*.js', 'src/**/*.svelte'],
    plugins: {
      'no-bare-drizzle': {
        rules: { 'no-bare-call': noBaredrizzle },
      },
    },
    rules: {
      'no-bare-drizzle/no-bare-call': 'error',
    },
  },
]
