/**
 * Story 23.2 AC-6 edge case: "Precedence with AUTH_REGISTRATION_ENABLED=false. POST /register
 * already returns 403 registration_disabled when that env flag is off. When both apply, the
 * EXISTING registration_disabled response wins — the new gate must not change an error code a
 * deployment already depends on." Accepted, deliberate deviation from the "one stable, generic
 * error" property AC-6 opens with (adversarial finding L1) — see routes.ts's `/register` handler,
 * which checks `AUTH_REGISTRATION_ENABLED` before anything else, native-login gate included.
 *
 * env.AUTH_REGISTRATION_ENABLED is a frozen-at-import singleton (config/env.ts's
 * `export const env = loadEnv()`), so this MUST be set before any module in this process imports
 * config/env.js — it cannot be toggled mid-test the way `native-login-policy`'s own module-level
 * `policy` singleton can via `__resetNativeLoginPolicyForTests()`. Split into its own file for
 * exactly that reason; every other native-login-gate test in this codebase runs under the default
 * AUTH_REGISTRATION_ENABLED=true and is therefore an implicit regression guard that this flag
 * being unset never produces `registration_disabled` by accident.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'

process.env['AUTH_REGISTRATION_ENABLED'] = 'false'
process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
configureAuthIntegrationEnv()

const { createApp } = await import('../../app.js')
const { initVault } = await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const { markReplacementProven, resolveNativeLoginPolicy } = await import('./native-login-policy.js')

const TEST_PASSPHRASE = 'register-disabled-precedence-tests-passphrase'
const REGISTER_URL = '/api/v1/auth/register'

describe('Story 23.2 AC-6: AUTH_REGISTRATION_ENABLED=false wins over native_login_disabled', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  it('registration disabled AND native login disabled: the existing registration_disabled response wins', async () => {
    const app = await createApp({ logger: false })
    try {
      await markReplacementProven()
      await resolveNativeLoginPolicy({
        status: 'loaded',
        manifest: {
          name: 'test.mock-envelope-extension',
          apiVersion: '1.2.0',
          capabilities: ['auth-provider'],
          replacesNativeLogin: true,
        },
        loadedAt: new Date().toISOString(),
        hooks: {
          authStrategy: {
            onAuthenticate: async () => ({ externalSubject: 'x', providerName: 'test' }),
          },
        },
      })

      const res = await app.inject({
        method: 'POST',
        url: REGISTER_URL,
        payload: { email: 'whoever@example.com', password: 'whatever-value', orgName: 'Org' },
      })

      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'registration_disabled' })
    } finally {
      await app.close()
    }
  })
})
