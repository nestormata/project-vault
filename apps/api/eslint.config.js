import { baseRules, secretsRules, apiEnforcement } from '@project-vault/eslint-config'

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/.stryker-tmp/**'],
  },
  ...baseRules,
  ...secretsRules,
  ...apiEnforcement,
  // Story 7.2 D11: the mandatory cross-compatibility test proving packages/crypto/src/aes.ts and
  // packages/agent/src/cache-crypto.ts produce interoperable ciphertext needs the raw
  // bootstrapDecrypt primitive to test both directions — same exception shape as
  // modules/vault/key-service.ts's own carve-out in packages/eslint-config/index.js.
  {
    files: ['src/__tests__/agent-crypto-cross-compat.test.ts'],
    rules: {
      'no-bare-decrypt/no-bare-call': [
        'error',
        { blockedNames: ['decrypt'], allowNames: ['bootstrapDecrypt'] },
      ],
    },
  },
]
