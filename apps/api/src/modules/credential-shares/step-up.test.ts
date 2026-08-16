import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '@project-vault/db'
import {
  bootstrapRouteIntegrationTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { enrollUserWithMfa } from '../../__tests__/helpers/mfa-enroll-test-helpers.js'
import { totpForSecret } from '../../__tests__/helpers/totp.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { verifyStepUp } from './step-up.js'
import {
  __resetNativeLoginPolicyForTests,
  resolveNativeLoginPolicy,
} from '../auth/native-login-policy.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const PASSWORD = 'correct-horse-battery-staple'

describe('credential-shares step-up re-authentication', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    app = await createApp()
    await initVault({ kmsType: 'passphrase', passphrase: 'step-up-test-passphrase' }, {})
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('AC-3: a correct password succeeds', async () => {
    const email = `step-up-pw-ok-${randomUUID()}@example.com`
    const user = await registerAndLoginViaApi(app, {
      email,
      password: PASSWORD,
      orgName: `Step Up Org ${randomUUID()}`,
    })

    const result = await getDb().transaction((tx) =>
      verifyStepUp(tx, { userId: user.userId, password: PASSWORD })
    )

    expect(result).toEqual({ status: 'ok' })
  })

  it('AC-3: a stale/wrong password fails as invalid_password, nothing persisted', async () => {
    const email = `step-up-pw-bad-${randomUUID()}@example.com`
    const user = await registerAndLoginViaApi(app, {
      email,
      password: PASSWORD,
      orgName: `Step Up Org ${randomUUID()}`,
    })

    const result = await getDb().transaction((tx) =>
      verifyStepUp(tx, { userId: user.userId, password: 'definitely-wrong' })
    )

    expect(result).toEqual({ status: 'invalid_password' })
  })

  it('AC-3: a correct TOTP code succeeds for a sharer with MFA enrolled', async () => {
    const enrolled = await enrollUserWithMfa(app, {
      emailPrefix: 'step-up-totp-ok',
      orgNamePrefix: 'Step Up TOTP Org',
      password: PASSWORD,
    })

    // Distinct 30s period from the enrollment TOTP already consumed above, so this isn't
    // rejected as a replay of the enrollment code (same pattern as mfa-login.integration.test.ts).
    const code = totpForSecret(enrolled.secret, Date.now() + 30_000)
    const result = await getDb().transaction((tx) =>
      verifyStepUp(tx, { userId: enrolled.userId, totpCode: code })
    )

    expect(result).toEqual({ status: 'ok' })
  })

  it('AC-3: an expired/already-used TOTP code fails as invalid_totp (reuses totpUsedCodes replay check)', async () => {
    const enrolled = await enrollUserWithMfa(app, {
      emailPrefix: 'step-up-totp-replay',
      orgNamePrefix: 'Step Up TOTP Org',
      password: PASSWORD,
    })

    // enrollmentTotp was already consumed by the enroll/verify-enrollment flow above.
    const result = await getDb().transaction((tx) =>
      verifyStepUp(tx, { userId: enrolled.userId, totpCode: enrolled.enrollmentTotp })
    )

    expect(result).toEqual({ status: 'invalid_totp' })
  })

  it('AC-3: no MFA enrolled + a TOTP code supplied fails as invalid_totp, not a false ok', async () => {
    const email = `step-up-no-mfa-${randomUUID()}@example.com`
    const user = await registerAndLoginViaApi(app, {
      email,
      password: PASSWORD,
      orgName: `Step Up Org ${randomUUID()}`,
    })

    const result = await getDb().transaction((tx) =>
      verifyStepUp(tx, { userId: user.userId, totpCode: '000000' })
    )

    expect(result).toEqual({ status: 'invalid_totp' })
  })

  it('AC-3: neither password nor totpCode supplied fails with a distinct missing_factor code', async () => {
    const email = `step-up-missing-${randomUUID()}@example.com`
    const user = await registerAndLoginViaApi(app, {
      email,
      password: PASSWORD,
      orgName: `Step Up Org ${randomUUID()}`,
    })

    const result = await getDb().transaction((tx) => verifyStepUp(tx, { userId: user.userId }))

    expect(result).toEqual({ status: 'missing_factor' })
  })

  describe('Story 23.2 AC-6b: password factor is gated when native login is disabled', () => {
    // Each test in this block needs to register (via a real POST /register) BEFORE gating the
    // policy, since AC-6a's bootstrap carve-out only ever allows the very first user overall —
    // a beforeEach reset back to enabled keeps every test's own registration call independent of
    // whatever the previous test in this file left the module-level policy singleton at.
    beforeEach(async () => {
      __resetNativeLoginPolicyForTests()
      await resolveNativeLoginPolicy({ status: 'not_configured' })
    })

    afterAll(async () => {
      __resetNativeLoginPolicyForTests()
      await resolveNativeLoginPolicy({ status: 'not_configured' })
    })

    async function gatePolicy(): Promise<void> {
      const declaredLoaded: import('../../extensions/loader.js').ExtensionState = {
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
            onAuthenticate: async () => ({ externalSubject: 'x', providerName: 't' }),
          },
        },
      }
      const { markReplacementProven } = await import('../auth/native-login-policy.js')
      await markReplacementProven('test.mock-envelope-extension')
      __resetNativeLoginPolicyForTests()
      await resolveNativeLoginPolicy(declaredLoaded)
    }

    it('a correct password is rejected as missing_factor (never reads users.passwordHash) once the policy is disabled', async () => {
      const email = `step-up-gated-${randomUUID()}@example.com`
      const user = await registerAndLoginViaApi(app, {
        email,
        password: PASSWORD,
        orgName: `Step Up Org ${randomUUID()}`,
      })

      await gatePolicy()

      const result = await getDb().transaction((tx) =>
        verifyStepUp(tx, { userId: user.userId, password: PASSWORD })
      )

      // Deliberately 'missing_factor', not 'invalid_password' — see AC-6b item 4 below: the
      // route renders a different message for each, and 'invalid_password' would leak whether
      // native login is disabled to any authenticated caller who supplies a password.
      expect(result).toEqual({ status: 'missing_factor' })
    })

    it('AC-6b item 4: "password supplied" and "no factor supplied" are indistinguishable under exclusion — the oracle is closed', async () => {
      const email = `step-up-oracle-${randomUUID()}@example.com`
      const user = await registerAndLoginViaApi(app, {
        email,
        password: PASSWORD,
        orgName: `Step Up Org ${randomUUID()}`,
      })

      await gatePolicy()

      const withPassword = await getDb().transaction((tx) =>
        verifyStepUp(tx, { userId: user.userId, password: PASSWORD })
      )
      const withNoFactor = await getDb().transaction((tx) =>
        verifyStepUp(tx, { userId: user.userId })
      )

      expect(withPassword).toEqual(withNoFactor)
      expect(withPassword).toEqual({ status: 'missing_factor' })
    })

    it('the TOTP factor is untouched by the gate', async () => {
      await gatePolicy()
      const result = await getDb().transaction((tx) =>
        verifyStepUp(tx, { userId: randomUUID(), totpCode: '000000' })
      )
      expect(result).toEqual({ status: 'invalid_totp' })
    })

    it('both factors supplied: password ignored, TOTP evaluated', async () => {
      const enrolled = await enrollUserWithMfa(app, {
        emailPrefix: 'step-up-both-factors',
        orgNamePrefix: 'Step Up Both Factors Org',
        password: PASSWORD,
      })
      await gatePolicy()

      const code = totpForSecret(enrolled.secret, Date.now() + 30_000)
      const result = await getDb().transaction((tx) =>
        verifyStepUp(tx, { userId: enrolled.userId, password: PASSWORD, totpCode: code })
      )

      expect(result).toEqual({ status: 'ok' })
    })
  })

  it('AC-6b: native login enabled (the default) — password path behaves byte-identically to today', async () => {
    const email = `step-up-enabled-regression-${randomUUID()}@example.com`
    const user = await registerAndLoginViaApi(app, {
      email,
      password: PASSWORD,
      orgName: `Step Up Org ${randomUUID()}`,
    })

    const correct = await getDb().transaction((tx) =>
      verifyStepUp(tx, { userId: user.userId, password: PASSWORD })
    )
    const wrong = await getDb().transaction((tx) =>
      verifyStepUp(tx, { userId: user.userId, password: 'nope' })
    )

    expect(correct).toEqual({ status: 'ok' })
    expect(wrong).toEqual({ status: 'invalid_password' })
  })
})
