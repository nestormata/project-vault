import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { adminAlerts, organizations } from '@project-vault/db/schema'
import { createApp } from '../../app.js'
import {
  configureAuthIntegrationEnv,
  parseSetCookies,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { initVaultForTest } from '../../__tests__/helpers/auth-test-helpers.js'

configureAuthIntegrationEnv()

const TOKEN = 'test-only-service-revocation-token-32-bytes-min'
const TOKEN_HEADER = 'x-service-revocation-token'
const VAULT_SECRET = 'revoke-sessions-routes-vault-secret'

type InjectResponse = Awaited<ReturnType<Awaited<ReturnType<typeof createApp>>['inject']>>
type SuccessBody = {
  data: {
    organizationId: string
    sessionsRevokedCount: number
    apiKeysRevokedCount: number
    requestId: string
  }
}
type ErrorBody = { code: string; message: string }

function successBody(res: InjectResponse): SuccessBody {
  return res.json() as SuccessBody
}
function errorBody(res: InjectResponse): ErrorBody {
  return res.json() as ErrorBody
}

async function setCentralizemeOrgId(orgId: string, centralizemeOrganizationId: string | null) {
  await getDb()
    .update(organizations)
    .set({ centralizemeOrganizationId })
    .where(eq(organizations.id, orgId))
}

function revokeUrl(centralizemeOrganizationId: string): string {
  return `/api/v1/service/organizations/${encodeURIComponent(centralizemeOrganizationId)}/revoke-sessions`
}

describe.sequential(
  'POST /api/v1/service/organizations/:centralizemeOrganizationId/revoke-sessions',
  () => {
    let originalToken: string | undefined

    beforeEach(async () => {
      const { env } = await import('../../config/env.js')
      originalToken = (env as unknown as Record<string, unknown>)['SERVICE_REVOCATION_TOKEN'] as
        string | undefined
      ;(env as unknown as Record<string, unknown>)['SERVICE_REVOCATION_TOKEN'] = TOKEN
    })

    afterEach(async () => {
      const { env } = await import('../../config/env.js')
      ;(env as unknown as Record<string, unknown>)['SERVICE_REVOCATION_TOKEN'] = originalToken
    })

    async function freshApp() {
      await resetVaultForTest()
      const { initVault } = await import('../../modules/vault/key-service.js')
      await initVaultForTest(initVault, VAULT_SECRET)
      return createApp({ logger: false, vaultGuardEnabled: true })
    }

    async function registerOrgWithCmId(app: Awaited<ReturnType<typeof createApp>>, label: string) {
      const email = `revoke-routes-${label}-${randomUUID()}@example.com`
      const user = await registerAndLoginViaApi(app, {
        email,
        password: 'correct-horse-battery-staple',
        orgName: `RevokeRoutes ${label} ${randomUUID()}`,
      })
      const centralizemeOrganizationId = `org_synthetic_${randomUUID()}`
      await setCentralizemeOrgId(user.orgId, centralizemeOrganizationId)
      return { ...user, email, centralizemeOrganizationId }
    }

    it('AC1.1: happy path — revokes sessions, returns two independent counts and the echoed requestId', async () => {
      const app = await freshApp()
      const owner = await registerOrgWithCmId(app, 'happy')
      const requestId = randomUUID()

      const res = await app.inject({
        method: 'POST',
        url: revokeUrl(owner.centralizemeOrganizationId),
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId },
      })

      expect(res.statusCode).toBe(200)
      const body = successBody(res)
      expect(body.data.organizationId).toBe(owner.orgId)
      expect(body.data.sessionsRevokedCount).toBeGreaterThanOrEqual(1)
      expect(body.data.apiKeysRevokedCount).toBe(0)
      expect(body.data.requestId).toBe(requestId)
      await app.close()
    })

    it('AC1.2: missing header returns 403 service_revocation_forbidden', async () => {
      const app = await freshApp()
      const owner = await registerOrgWithCmId(app, 'missing-header')

      const res = await app.inject({
        method: 'POST',
        url: revokeUrl(owner.centralizemeOrganizationId),
        payload: { requestId: randomUUID() },
      })

      expect(res.statusCode).toBe(403)
      expect(errorBody(res).code).toBe('service_revocation_forbidden')
      await app.close()
    })

    it('AC1.3: wrong token returns the same 403 service_revocation_forbidden', async () => {
      const app = await freshApp()
      const owner = await registerOrgWithCmId(app, 'wrong-token')

      const res = await app.inject({
        method: 'POST',
        url: revokeUrl(owner.centralizemeOrganizationId),
        headers: { [TOKEN_HEADER]: 'x'.repeat(TOKEN.length) },
        payload: { requestId: randomUUID() },
      })

      expect(res.statusCode).toBe(403)
      expect(errorBody(res).code).toBe('service_revocation_forbidden')
      await app.close()
    })

    it('AC1.4: env var unset makes the route unreachable for every request (fail-closed)', async () => {
      const app = await freshApp()
      const owner = await registerOrgWithCmId(app, 'unset-env')
      const { env } = await import('../../config/env.js')
      ;(env as unknown as Record<string, unknown>)['SERVICE_REVOCATION_TOKEN'] = undefined

      const res = await app.inject({
        method: 'POST',
        url: revokeUrl(owner.centralizemeOrganizationId),
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID() },
      })

      expect(res.statusCode).toBe(403)
      expect(errorBody(res).code).toBe('service_revocation_forbidden')
      await app.close()
    })

    it('AC3.11: no matching CM org id returns 404 org_not_found', async () => {
      const app = await freshApp()

      const res = await app.inject({
        method: 'POST',
        url: revokeUrl(`org_does_not_exist_${randomUUID()}`),
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID() },
      })

      expect(res.statusCode).toBe(404)
      expect(errorBody(res).code).toBe('org_not_found')
      await app.close()
    })

    it('AC3.11 (DW-153 gap): an org whose centralizeme_organization_id is still null returns 404', async () => {
      const app = await freshApp()
      const owner = await registerOrgWithCmId(app, 'null-cm-id')
      await setCentralizemeOrgId(owner.orgId, null)

      const res = await app.inject({
        method: 'POST',
        url: revokeUrl(owner.centralizemeOrganizationId),
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID() },
      })

      expect(res.statusCode).toBe(404)
      expect(errorBody(res).code).toBe('org_not_found')
      await app.close()
    })

    it('AC3.13: a whitespace-only centralizemeOrganizationId param returns 422', async () => {
      const app = await freshApp()

      const res = await app.inject({
        method: 'POST',
        url: revokeUrl('   '),
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID() },
      })

      expect(res.statusCode).toBe(422)
      expect(errorBody(res).code).toBe('validation_error')
      await app.close()
    })

    it('AC3.13: an over-256-character centralizemeOrganizationId param returns 422', async () => {
      const app = await freshApp()

      const res = await app.inject({
        method: 'POST',
        url: revokeUrl('a'.repeat(257)),
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID() },
      })

      expect(res.statusCode).toBe(422)
      await app.close()
    })

    it('AC5.19: an unexpected orgId body field is rejected with 422, never widening scope', async () => {
      const app = await freshApp()
      const owner = await registerOrgWithCmId(app, 'strict-body')
      const other = await registerOrgWithCmId(app, 'strict-body-other')

      const res = await app.inject({
        method: 'POST',
        url: revokeUrl(owner.centralizemeOrganizationId),
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID(), orgId: other.orgId },
      })

      expect(res.statusCode).toBe(422)
      await app.close()
    })

    it('AC6.21: a live session dies on its very next request after the route commits', async () => {
      const app = await freshApp()
      const owner = await registerOrgWithCmId(app, 'live-session')
      const cookies = parseSetCookies(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/login',
            payload: { email: owner.email, password: 'correct-horse-battery-staple' },
          })
        ).headers['set-cookie']
      )

      const before = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: {
          cookie: Object.entries(cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; '),
        },
      })
      expect(before.statusCode).toBe(200)

      const revokeRes = await app.inject({
        method: 'POST',
        url: revokeUrl(owner.centralizemeOrganizationId),
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID() },
      })
      expect(revokeRes.statusCode).toBe(200)

      const after = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: {
          cookie: Object.entries(cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; '),
        },
      })
      expect(after.statusCode).toBe(401)
      expect(errorBody(after).code).toBe('session_revoked')
      await app.close()
    })

    it('AC8.28/AC14.45: a coarse route-wide rate limit rejects the 31st request in a minute with 429', async () => {
      const previousBypass = process.env['RATE_LIMIT_TEST_BYPASS']
      process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
      const app = await freshApp()
      const owner = await registerOrgWithCmId(app, 'rate-limit')

      let last429: InjectResponse | undefined
      for (let i = 0; i < 31; i++) {
        const res = await app.inject({
          method: 'POST',
          url: revokeUrl(owner.centralizemeOrganizationId),
          headers: { [TOKEN_HEADER]: TOKEN },
          payload: { requestId: randomUUID() },
        })
        if (res.statusCode === 429) {
          last429 = res
          break
        }
      }

      expect(last429?.statusCode).toBe(429)
      await app.close()
      process.env['RATE_LIMIT_TEST_BYPASS'] = previousBypass
    })

    it('AC14.46: fires an operator alert on every successful call', async () => {
      const app = await freshApp()
      const owner = await registerOrgWithCmId(app, 'alert')

      const before = await getDb()
        .select({ id: adminAlerts.id })
        .from(adminAlerts)
        .where(eq(adminAlerts.alertType, 'org.sessions_revoked_by_service'))

      const res = await app.inject({
        method: 'POST',
        url: revokeUrl(owner.centralizemeOrganizationId),
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID() },
      })
      expect(res.statusCode).toBe(200)

      const after = await getDb()
        .select({ id: adminAlerts.id })
        .from(adminAlerts)
        .where(eq(adminAlerts.alertType, 'org.sessions_revoked_by_service'))
      expect(after.length).toBe(before.length + 1)
      await app.close()
    })
  }
)
