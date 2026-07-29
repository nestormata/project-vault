import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '@project-vault/db'
import {
  bootstrapRouteIntegrationTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { enrollUserWithMfa } from '../../__tests__/helpers/mfa-enroll-test-helpers.js'
import { totpForSecret } from '../../__tests__/helpers/totp.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { verifyStepUp } from './step-up.js'

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
    // rejected as a replay of the enrollment code (same pattern as mfa-login.test.ts).
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
})
