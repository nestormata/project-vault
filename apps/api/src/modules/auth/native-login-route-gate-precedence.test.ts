import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import {
  __resetNativeLoginPolicyForTests,
  markReplacementProven,
  resolveNativeLoginPolicy,
} from './native-login-policy.js'
import type { ExtensionState } from '../../extensions/loader.js'

/**
 * Story 23.2 AC-6: a precedence/preservation property `native-login-route-gate.test.ts`
 * deliberately does NOT cover, because that suite globally bypasses rate limiting
 * (RATE_LIMIT_TEST_BYPASS=true) to avoid tripping shared buckets across its many assertions —
 * exactly the setting this test needs OFF. Split into its own file/process rather than toggling
 * the env var mid-suite (register-rate-limit.test.ts's own established pattern: each createApp()
 * call reads env once at construction).
 */
configureAuthIntegrationEnv()

const { createApp } = await import('../../app.js')
const { initVault } = await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const { env } = await import('../../config/env.js')

const TEST_PASSPHRASE = 'route-gate-precedence-tests-passphrase'
const LOGIN_URL = '/api/v1/auth/login'

const DECLARED_LOADED: ExtensionState = {
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
}

async function forcePolicyDisabled(): Promise<void> {
  await markReplacementProven('test.mock-envelope-extension')
  __resetNativeLoginPolicyForTests()
  await resolveNativeLoginPolicy(DECLARED_LOADED)
}

async function forcePolicyEnabled(): Promise<void> {
  __resetNativeLoginPolicyForTests()
  await resolveNativeLoginPolicy({ status: 'not_configured' })
}

describe('Story 23.2 AC-6: rate limiting still takes precedence over the native-login gate', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
  })

  afterAll(async () => {
    await forcePolicyEnabled()
    await resetVaultForTest()
  })

  it('POST /login: exceeding the rate limit under exclusion returns 429, not 403 (AC-6 edge case, finding M2)', async () => {
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    const app = await createApp({ logger: false })
    try {
      await forcePolicyDisabled()

      const responses: Awaited<ReturnType<typeof app.inject>>[] = []
      for (let i = 0; i < env.AUTH_RATE_LIMIT_MAX + 1; i += 1) {
        responses.push(
          await app.inject({
            method: 'POST',
            url: LOGIN_URL,
            payload: { email: `rl-${i}@example.com`, password: 'whatever-value' },
          })
        )
      }
      const last = responses.at(-1)

      expect(last?.statusCode).toBe(429)
      expect(last?.json()).toMatchObject({ code: 'rate_limit_exceeded' })
    } finally {
      await app.close()
      delete process.env['RATE_LIMIT_TEST_BYPASS']
    }
  }, 30_000)
})
