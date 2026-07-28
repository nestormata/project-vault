import typescriptEslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import security from 'eslint-plugin-security'
import sonarjs from 'eslint-plugin-sonarjs'
import noSecrets from 'eslint-plugin-no-secrets'
import svelte from 'eslint-plugin-svelte'
import prettierConfig from 'eslint-config-prettier'
import { noBaredrizzle } from './rules/no-bare-drizzle.js'
import { noBareDecrypt } from './rules/no-bare-decrypt.js'
import { noErrorSchemaFirstInUnion } from './rules/no-error-schema-first-in-union.js'
import { noContiguousAllowedRoles } from './rules/no-contiguous-allowed-roles.js'

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
      'no-error-schema-first-in-union': {
        rules: { 'no-error-schema-first-in-union': noErrorSchemaFirstInUnion },
      },
      'no-contiguous-allowed-roles': {
        rules: { 'no-contiguous-allowed-roles': noContiguousAllowedRoles },
      },
    },
    rules: {
      'no-bare-drizzle/no-bare-call': 'error',
      // no-bare-decrypt: block both decrypt and bootstrapDecrypt everywhere in the API
      // (bootstrapDecrypt is the re-exported alias; same security constraint applies)
      'no-bare-decrypt/no-bare-call': ['error', { blockedNames: ['decrypt', 'bootstrapDecrypt'] }],
      // P5-1 (Epic 5 retro, reaffirmed unenforced in Epic 5 round-3 and Epic 14 round-2): Fastify's
      // response serializer matches z.union([...]) members in array order, so the generic
      // ApiErrorSchema must always be last.
      'no-error-schema-first-in-union/no-error-schema-first-in-union': 'error',
      // no-contiguous-allowed-roles is deliberately NOT enabled here (see the scoped block below)
      // — the plugin is registered once, in this broad block, so the narrower override further
      // down can turn the rule on for specific files without re-registering the plugin (ESLint
      // flat config errors on duplicate plugin registration for overlapping file globs).
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
  // Story 14.8 (Epic 14 retro Finding 3): default to minimumRole for "this role or higher" RBAC
  // gates; allowedRoles is reserved for a documented non-contiguous exception. See
  // architecture.md's "RBAC Role-Gate Convention" (Enforcement Guidelines).
  //
  // Scoped rollout, not repo-wide: this story (14.8) audited and retrofitted
  // apps/api/src/modules/org/routes.ts, and verified the two known legitimate non-contiguous
  // exceptions (extensions/status-routes.ts, auth/external-identity-routes.ts) are clean. A
  // repo-wide dry run (Subtask 5.5) found ~14 pre-existing contiguous-allowedRoles-without-comment
  // sites in OTHER files (admin/routes.ts, credentials/routes.ts, notifications/routes.ts,
  // security-alert-actions-routes.ts, theming/routes.ts, users/routes.ts) that predate this
  // convention and are out of this story's scope to convert or annotate (see Dev Notes: ~140+
  // other minimumRole/allowedRoles sites are explicitly out of scope). Enabling 'error' repo-wide
  // today would break `make ci` on code this story must not touch. Flagged as a candidate for
  // deferred-work.md: a follow-up story should review those sites and either add the required
  // exception comment or convert to minimumRole, then widen this rule's `files` glob to
  // `src/**/*.ts` to match the other apiEnforcement rules.
  {
    files: [
      'src/modules/org/routes.ts',
      'src/extensions/status-routes.ts',
      'src/modules/auth/external-identity-routes.ts',
    ],
    rules: {
      'no-contiguous-allowed-roles/no-contiguous-allowed-roles': 'error',
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
