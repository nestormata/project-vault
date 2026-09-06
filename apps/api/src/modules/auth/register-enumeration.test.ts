import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { RegisterAcceptedResponseSchema } from './schema.js'

configureAuthIntegrationEnv()

// AC-3 edge case: the schema's entire job is guaranteeing no extra, potentially-identifying
// field ever leaks onto this response — assert `.strict()` actually rejects one.
describe('RegisterAcceptedResponseSchema (Story 1.20 AC-3)', () => {
  it('accepts the documented { message } shape', () => {
    expect(
      RegisterAcceptedResponseSchema.safeParse({ message: 'If that email is available...' }).success
    ).toBe(true)
  })

  it('rejects extra keys (e.g. an accidentally-included userId) via .strict()', () => {
    expect(
      RegisterAcceptedResponseSchema.safeParse({ message: '...', userId: 'user-1' }).success
    ).toBe(false)
  })
})

const { createApp } = await import('../../app.js')
const { initVault } = await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')

const TEST_PASSPHRASE = 'register-enumeration-tests-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const REGISTER_URL = '/api/v1/auth/register'
const LOGIN_URL = '/api/v1/auth/login'
const GENERIC_ACCEPTED_MESSAGE =
  'If that email is available, your account has been created and you can sign in.'

function uniqueEmail(label: string): string {
  return `register-enum-${label}-${randomUUID()}@example.com`
}

describe('POST /register self-signup enumeration fix (Story 1.20)', () => {
  let app: Awaited<ReturnType<typeof createApp>>

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  // AC-1 happy path, AC-3
  it('returns 202 with the generic accepted body for a novel self-signup email, and the account can log in', async () => {
    const email = uniqueEmail('novel')
    const res = await app.inject({
      method: 'POST',
      url: REGISTER_URL,
      payload: { email, password: PASSWORD, orgName: `Novel Org ${randomUUID()}` },
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ message: GENERIC_ACCEPTED_MESSAGE })

    // AC-5 happy path: the account genuinely exists and can log in.
    const login = await app.inject({
      method: 'POST',
      url: LOGIN_URL,
      payload: { email, password: PASSWORD },
    })
    expect(login.statusCode).toBe(200)
  })

  // AC-1 edge case, AC-2, AC-5 edge case
  it('returns the identical 202 generic body for an already-registered self-signup email, with no new account created', async () => {
    const email = uniqueEmail('taken')
    const first = await app.inject({
      method: 'POST',
      url: REGISTER_URL,
      payload: { email, password: PASSWORD, orgName: `Taken Org ${randomUUID()}` },
    })
    expect(first.statusCode).toBe(202)

    const second = await app.inject({
      method: 'POST',
      url: REGISTER_URL,
      payload: {
        email,
        password: 'a-completely-different-password-1',
        orgName: `Retry Org ${randomUUID()}`,
      },
    })

    // AC-2: byte-for-byte identical status + body across the novel and taken-email branches.
    expect(second.statusCode).toBe(first.statusCode)
    expect(second.json()).toEqual(first.json())
    expect(second.json()).toEqual({ message: GENERIC_ACCEPTED_MESSAGE })

    // AC-5 edge case: the original account's password is unaffected (no takeover, no account
    // created for the second submission).
    const loginOriginal = await app.inject({
      method: 'POST',
      url: LOGIN_URL,
      payload: { email, password: PASSWORD },
    })
    expect(loginOriginal.statusCode).toBe(200)

    const loginWithSecondPassword = await app.inject({
      method: 'POST',
      url: LOGIN_URL,
      payload: { email, password: 'a-completely-different-password-1' },
    })
    expect(loginWithSecondPassword.statusCode).toBe(401)
  })

  // Regression guard, explicit per AC-9.
  it('self-signup register response is identical for a novel vs. already-registered email (anti-enumeration regression guard)', async () => {
    const takenEmail = uniqueEmail('guard-taken')
    await app.inject({
      method: 'POST',
      url: REGISTER_URL,
      payload: { email: takenEmail, password: PASSWORD, orgName: `Guard Org ${randomUUID()}` },
    })

    const novelRes = await app.inject({
      method: 'POST',
      url: REGISTER_URL,
      payload: {
        email: uniqueEmail('guard-novel'),
        password: PASSWORD,
        orgName: `Guard Org 2 ${randomUUID()}`,
      },
    })
    const takenRes = await app.inject({
      method: 'POST',
      url: REGISTER_URL,
      payload: { email: takenEmail, password: PASSWORD, orgName: `Guard Org 3 ${randomUUID()}` },
    })

    expect(novelRes.statusCode).toBe(takenRes.statusCode)
    expect(novelRes.json()).toEqual(takenRes.json())
  })

  // AC-2 edge case: malformed email still hits 422 validation_error, unaffected by this fix.
  it('still returns 422 validation_error for a malformed email, unaffected by the enumeration fix', async () => {
    const res = await app.inject({
      method: 'POST',
      url: REGISTER_URL,
      payload: { email: 'not-an-email', password: PASSWORD, orgName: `Bad Org ${randomUUID()}` },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'validation_error' })
  })
})
