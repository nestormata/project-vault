import { beforeAll, describe, expect, it, vi } from 'vitest'
import { configureAuthIntegrationEnv } from '../../__tests__/helpers/auth-test-helpers.js'

// Story 22.1 code-review fix: /mfa/verify-login is a raw fastify.route() handler outside
// SecureRoute (see routes.ts sendRecoveryFailure), so a SameTransactionAuditWriteError thrown
// from verifyLogin (e.g. because the per-org audit quota gate refused the write, or the gate
// statement itself errored) must be translated into the same 503 audit_quota_exhausted /
// audit_gate_unavailable contract SecureRoute uses elsewhere — not fall through to a bare 500.
// Mocking verifyLogin directly (rather than seeding real quota-exhausted DB state) keeps this
// deterministic and exercises both branches without depending on quota-gate internals.
configureAuthIntegrationEnv()

vi.mock('./mfa-login.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mfa-login.js')>()
  return {
    ...actual,
    verifyLogin: vi.fn(),
  }
})

const VERIFY_LOGIN_URL = '/api/v1/auth/mfa/verify-login'
const VALID_BODY = { mfaToken: 'a'.repeat(20), totp: '123456' }

let createApp: typeof import('../../app.js').createApp

describe('/mfa/verify-login audit-gate failure translation', () => {
  beforeAll(async () => {
    createApp = (await import('../../app.js')).createApp
  })

  it('sends a 503 audit_quota_exhausted response when verifyLogin fails closed on quota', async () => {
    const { verifyLogin } = await import('./mfa-login.js')
    const { SameTransactionAuditWriteError } = await import('../../lib/secure-route.js')
    vi.mocked(verifyLogin).mockRejectedValueOnce(
      new SameTransactionAuditWriteError('quota exhausted', 'audit_quota_exhausted')
    )

    const app = await createApp({ logger: false })
    const response = await app.inject({
      method: 'POST',
      url: VERIFY_LOGIN_URL,
      payload: VALID_BODY,
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      code: 'audit_quota_exhausted',
      message: 'Audit storage quota exhausted for this organization',
    })

    await app.close()
  })

  it('sends a 503 audit_gate_unavailable response when the audit quota gate statement errors', async () => {
    const { verifyLogin } = await import('./mfa-login.js')
    const { SameTransactionAuditWriteError } = await import('../../lib/secure-route.js')
    vi.mocked(verifyLogin).mockRejectedValueOnce(
      new SameTransactionAuditWriteError('gate down', 'audit_gate_unavailable')
    )

    const app = await createApp({ logger: false })
    const response = await app.inject({
      method: 'POST',
      url: VERIFY_LOGIN_URL,
      payload: VALID_BODY,
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      code: 'audit_gate_unavailable',
      message: 'Audit quota gate is unavailable',
    })

    await app.close()
  })
})
