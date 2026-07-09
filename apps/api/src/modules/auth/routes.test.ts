import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createUnsealedRouteSuite } from '../../__tests__/helpers/unsealed-route-suite-test-helpers.js'
import { registerPlatformOperator } from '../../__tests__/helpers/platform-operator-test-helpers.js'

// Only fall back to the default local port when DATABASE_URL isn't already set (e.g. by
// `make test`, which points at whatever host port this worktree's Postgres actually uses —
// see prune-credential-versions.test.ts for the same pattern).
process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

let createApp: typeof import('../../app.js').createApp

type OpenApiDocument = {
  paths?: Record<string, unknown>
}

const { initVault } = await bootstrapRouteIntegrationTest()

describe('auth routes', () => {
  beforeAll(async () => {
    createApp = (await import('../../app.js')).createApp
  })

  it('registers auth routes as POST-only with 405 for GET', async () => {
    const app = await createApp({ logger: false })
    const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' })
    const refresh = await app.inject({ method: 'GET', url: '/api/v1/auth/refresh' })
    const enroll = await app.inject({ method: 'GET', url: '/api/v1/auth/mfa/enroll' })
    const recover = await app.inject({ method: 'GET', url: '/api/v1/auth/mfa/recover' })
    const verifyLogin = await app.inject({ method: 'GET', url: '/api/v1/auth/mfa/verify-login' })

    expect(login.statusCode).toBe(405)
    expect(login.headers['allow']).toBe('POST')
    expect(refresh.statusCode).toBe(405)
    expect(refresh.headers['allow']).toBe('POST')
    expect(enroll.statusCode).toBe(405)
    expect(enroll.headers['allow']).toBe('POST')
    expect(recover.statusCode).toBe(405)
    expect(recover.headers['allow']).toBe('POST')
    expect(verifyLogin.statusCode).toBe(405)
    expect(verifyLogin.headers['allow']).toBe('POST')

    await app.close()
  })

  it('protects MFA enrollment routes with access-token auth', async () => {
    const app = await createApp({ logger: false })

    const enroll = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enroll', payload: {} })
    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify-enrollment',
      payload: { totp: '123456' },
    })
    const regenerate = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/regenerate-recovery-codes',
      payload: { totp: '123456' },
    })

    expect(enroll.statusCode).toBe(401)
    expect(verify.statusCode).toBe(401)
    expect(regenerate.statusCode).toBe(401)

    await app.close()
  })

  it('accepts spaced TOTP input before auth enforcement', async () => {
    const app = await createApp({ logger: false })

    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify-enrollment',
      payload: { totp: '123 456' },
    })

    expect(verify.statusCode).toBe(401)

    await app.close()
  })

  it('registers MFA routes in the OpenAPI document', async () => {
    const app = await createApp({ logger: false })
    await app.ready()

    const document = app.swagger() as OpenApiDocument
    expect(document.paths?.['/api/v1/auth/me']).toBeDefined()
    expect(document.paths?.['/api/v1/auth/mfa/enroll']).toBeDefined()
    expect(document.paths?.['/api/v1/auth/mfa/verify-enrollment']).toBeDefined()
    expect(document.paths?.['/api/v1/auth/mfa/regenerate-recovery-codes']).toBeDefined()
    expect(document.paths?.['/api/v1/auth/mfa/recover']).toBeDefined()
    expect(document.paths?.['/api/v1/auth/mfa/verify-login']).toBeDefined()

    await app.close()
  })

  it('keeps MFA recover public while validating malformed bodies', async () => {
    const app = await createApp({ logger: false })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/recover',
      payload: { email: 'not-an-email', password: 'short', recoveryCode: 'bad' },
    })

    expect(response.statusCode).toBe(422)

    await app.close()
  })

  it('keeps MFA verify-login public while validating malformed bodies', async () => {
    const app = await createApp({ logger: false })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify-login',
      payload: { mfaToken: 'short', totp: 'bad' },
    })

    expect(response.statusCode).toBe(422)

    await app.close()
  })

  it('passes the SecureRoute transaction into protected MFA service actions', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'routes.ts'), 'utf-8')

    expect(source).toContain('enrollMfa(secureCtx.auth, metaFromRequest(_req), secureCtx.tx)')
    expect(source).toContain(
      'verifyEnrollment(secureCtx.auth, parsed.data, metaFromRequest(req), secureCtx.tx)'
    )
    expect(source).toContain(
      'regenerateRecoveryCodes(secureCtx.auth, parsed.data, metaFromRequest(req), secureCtx.tx)'
    )
  })
})

describe.sequential('GET /api/v1/auth/me', () => {
  const ME_URL = '/api/v1/auth/me'
  const suite = createUnsealedRouteSuite(initVault, 'auth-me-routes-passphrase')
  suite.registerLifecycle()

  it('returns the org name alongside orgId, not just the raw UUID', async () => {
    const orgName = `Me Route Org ${randomUUID()}`
    const { cookies } = await registerAndLoginViaApi(suite.app, {
      email: `me-route-${randomUUID()}@example.com`,
      password: 'correct-horse-battery-staple',
      orgName,
    })

    const me = await suite.app.inject({
      method: 'GET',
      url: ME_URL,
      headers: { cookie: cookieHeader(cookies) },
    })

    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ data: { orgName } })
  })

  it('AC-A1: returns isPlatformOperator:true for a platform operator and isPlatformOperator:false for a regular user', async () => {
    const PASSWORD = 'correct-horse-battery-staple'
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: `me-operator-${randomUUID()}`,
      orgNamePrefix: `Me Operator Org`,
      password: PASSWORD,
    })

    const meOperator = await suite.app.inject({
      method: 'GET',
      url: ME_URL,
      headers: { cookie: cookieHeader(operator.cookies) },
    })
    expect(meOperator.statusCode).toBe(200)
    expect(
      (meOperator.json() as { data: { isPlatformOperator: boolean } }).data.isPlatformOperator
    ).toBe(true)

    const { cookies: regularCookies } = await registerAndLoginViaApi(suite.app, {
      email: `me-regular-${randomUUID()}@example.com`,
      password: PASSWORD,
      orgName: `Me Regular Org ${randomUUID()}`,
    })
    const meRegular = await suite.app.inject({
      method: 'GET',
      url: ME_URL,
      headers: { cookie: cookieHeader(regularCookies) },
    })
    expect(meRegular.statusCode).toBe(200)
    expect(
      (meRegular.json() as { data: { isPlatformOperator: boolean } }).data.isPlatformOperator
    ).toBe(false)
  })
})
