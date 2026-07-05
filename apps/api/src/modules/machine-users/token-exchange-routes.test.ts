import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { apiKeys, machineUsers } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootMachineUserRouteTestApp } from './machine-user-route-test-bootstrap.js'
import { resetKeyHashRateLimitStateForTest } from './token-exchange-rate-limit.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner } = createMembershipTestHelpers({
  emailPrefix: 'machine-token-exchange',
  orgNamePrefix: 'Machine Token Exchange',
})

const MACHINE_TOKEN_URL = '/api/v1/auth/machine-token'

function machineUsersUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/machine-users`
}
function apiKeysUrl(machineUserId: string): string {
  return `/api/v1/machine-users/${machineUserId}/api-keys`
}

async function exchangeToken(app: TestApp, key: string | undefined) {
  return app.inject({
    method: 'POST',
    url: MACHINE_TOKEN_URL,
    headers: key ? { authorization: `Bearer ${key}` } : {},
  })
}

async function issueMachineUserAndKey(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string
): Promise<{ machineUserId: string; keyId: string; key: string }> {
  const muRes = await app.inject({
    method: 'POST',
    url: machineUsersUrl(projectId),
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: `bot-${randomUUID().slice(0, 8)}`, role: 'member' },
  })
  expect(muRes.statusCode).toBe(201)
  const machineUserId = muRes.json<{ data: { id: string } }>().data.id

  const keyRes = await app.inject({
    method: 'POST',
    url: apiKeysUrl(machineUserId),
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: 'ci-key' },
  })
  expect(keyRes.statusCode).toBe(201)
  const keyBody = keyRes.json<{ data: { id: string; key: string } }>().data

  return { machineUserId, keyId: keyBody.id, key: keyBody.key }
}

describe('POST /api/v1/auth/machine-token', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootMachineUserRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  describe('AC-2: happy path', () => {
    it('exchanges a valid pk_ key for a machine JWT with no Set-Cookie header', async () => {
      const owner = await registerOwner(app, 'happy-path')
      const projectId = await createProjectViaApi(app, owner.cookies, 'token-exchange-happy')
      const { key } = await issueMachineUserAndKey(app, owner.cookies, projectId)

      const res = await exchangeToken(app, key)

      expect(res.statusCode).toBe(200)
      const body = res.json<{
        data: { accessToken: string; tokenType: string; expiresIn: number }
      }>()
      expect(body.data.tokenType).toBe('Bearer')
      expect(body.data.expiresIn).toBeGreaterThan(0)
      expect(typeof body.data.accessToken).toBe('string')
      expect(body.data.accessToken.split('.')).toHaveLength(3)
      expect(res.headers['set-cookie']).toBeUndefined()
    })

    it('updates lastUsedAt on the exchanged key', async () => {
      const owner = await registerOwner(app, 'last-used')
      const projectId = await createProjectViaApi(app, owner.cookies, 'token-exchange-last-used')
      const { key, keyId } = await issueMachineUserAndKey(app, owner.cookies, projectId)

      const res = await exchangeToken(app, key)
      expect(res.statusCode).toBe(200)

      const [row] = await withOrg(owner.orgId, (tx) =>
        tx.select({ lastUsedAt: apiKeys.lastUsedAt }).from(apiKeys).where(eq(apiKeys.id, keyId))
      )
      expect(row?.lastUsedAt).not.toBeNull()
    })

    it('lets two distinct keys for the same machine user each authenticate independently', async () => {
      const owner = await registerOwner(app, 'multi-key')
      const projectId = await createProjectViaApi(app, owner.cookies, 'token-exchange-multi-key')
      const { machineUserId, key: keyA } = await issueMachineUserAndKey(
        app,
        owner.cookies,
        projectId
      )
      const keyBRes = await app.inject({
        method: 'POST',
        url: apiKeysUrl(machineUserId),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { name: 'second-key' },
      })
      const keyB = keyBRes.json<{ data: { key: string } }>().data.key

      const resA = await exchangeToken(app, keyA)
      const resB = await exchangeToken(app, keyB)

      expect(resA.statusCode).toBe(200)
      expect(resB.statusCode).toBe(200)
    })
  })

  describe('AC-3: invalid, expired, revoked, malformed key', () => {
    it('returns 401 access_token_missing when the Authorization header is absent', async () => {
      const res = await exchangeToken(app, undefined)
      expect(res.statusCode).toBe(401)
      expect(res.json()).toMatchObject({ code: 'access_token_missing' })
    })

    it('returns 401 invalid_api_key for a non-pk_-prefixed token with no DB query', async () => {
      const res = await exchangeToken(app, 'not-a-machine-key')
      expect(res.statusCode).toBe(401)
      expect(res.json()).toMatchObject({ code: 'invalid_api_key' })
    })

    it('returns 401 invalid_api_key for a well-formed but never-issued key', async () => {
      const res = await exchangeToken(app, `pk_${'a'.repeat(43)}`)
      expect(res.statusCode).toBe(401)
      expect(res.json()).toMatchObject({ code: 'invalid_api_key' })
    })

    it('returns 401 invalid_api_key for a revoked key', async () => {
      const owner = await registerOwner(app, 'revoked')
      const projectId = await createProjectViaApi(app, owner.cookies, 'token-exchange-revoked')
      const { machineUserId, keyId, key } = await issueMachineUserAndKey(
        app,
        owner.cookies,
        projectId
      )
      const revokeRes = await app.inject({
        method: 'DELETE',
        url: `${apiKeysUrl(machineUserId)}/${keyId}`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(revokeRes.statusCode).toBe(200)

      const res = await exchangeToken(app, key)
      expect(res.statusCode).toBe(401)
      expect(res.json()).toMatchObject({ code: 'invalid_api_key' })
    })

    it('returns 401 invalid_api_key for an expired key', async () => {
      const owner = await registerOwner(app, 'expired')
      const projectId = await createProjectViaApi(app, owner.cookies, 'token-exchange-expired')
      const { keyId, key } = await issueMachineUserAndKey(app, owner.cookies, projectId)

      await withOrg(owner.orgId, (tx) =>
        tx
          .update(apiKeys)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(apiKeys.id, keyId))
      )

      const res = await exchangeToken(app, key)
      expect(res.statusCode).toBe(401)
      expect(res.json()).toMatchObject({ code: 'invalid_api_key' })
    })

    it('returns 401 invalid_api_key when the owning machine user is deactivated', async () => {
      const owner = await registerOwner(app, 'deactivated')
      const projectId = await createProjectViaApi(app, owner.cookies, 'token-exchange-deactivated')
      const { machineUserId, key } = await issueMachineUserAndKey(app, owner.cookies, projectId)

      await withOrg(owner.orgId, (tx) =>
        tx
          .update(machineUsers)
          .set({ deactivatedAt: new Date() })
          .where(eq(machineUsers.id, machineUserId))
      )

      const res = await exchangeToken(app, key)
      expect(res.statusCode).toBe(401)
      expect(res.json()).toMatchObject({ code: 'invalid_api_key' })
    })
  })

  describe('AC-4: rate limiting and brute-force resistance', () => {
    it('returns 429 on the 11th failed attempt against the same key hash within 60s', async () => {
      process.env['RATE_LIMIT_TEST_ENFORCE'] = 'true'
      resetKeyHashRateLimitStateForTest()
      try {
        const owner = await registerOwner(app, 'keyhash-lockout')
        const projectId = await createProjectViaApi(app, owner.cookies, 'token-exchange-lockout')
        const { machineUserId, keyId, key } = await issueMachineUserAndKey(
          app,
          owner.cookies,
          projectId
        )
        await app.inject({
          method: 'DELETE',
          url: `${apiKeysUrl(machineUserId)}/${keyId}`,
          headers: { cookie: cookieHeader(owner.cookies) },
        })

        const responses = []
        for (let i = 0; i < 11; i += 1) {
          responses.push(await exchangeToken(app, key))
        }

        expect(responses.slice(0, 10).every((res) => res.statusCode === 401)).toBe(true)
        expect(responses[10]?.statusCode).toBe(429)
        expect(responses[10]?.json()).toMatchObject({ code: 'rate_limit_exceeded' })
      } finally {
        delete process.env['RATE_LIMIT_TEST_ENFORCE']
        resetKeyHashRateLimitStateForTest()
      }
    }, 30_000)

    it('does not reset the per-key-hash counter on a successful exchange with a different key', async () => {
      process.env['RATE_LIMIT_TEST_ENFORCE'] = 'true'
      resetKeyHashRateLimitStateForTest()
      try {
        const owner = await registerOwner(app, 'keyhash-independent')
        const projectId = await createProjectViaApi(
          app,
          owner.cookies,
          'token-exchange-independent'
        )
        const { key: goodKey } = await issueMachineUserAndKey(app, owner.cookies, projectId)

        for (let i = 0; i < 5; i += 1) {
          await exchangeToken(app, `pk_${'b'.repeat(43)}`)
        }
        const goodRes = await exchangeToken(app, goodKey)
        expect(goodRes.statusCode).toBe(200)
      } finally {
        delete process.env['RATE_LIMIT_TEST_ENFORCE']
        resetKeyHashRateLimitStateForTest()
      }
    }, 30_000)
  })
})
