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
      'no-bare-decrypt/no-bare-call': 'error',
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
