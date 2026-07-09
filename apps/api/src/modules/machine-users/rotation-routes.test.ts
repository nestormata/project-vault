import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { apiKeys, auditLogEntries } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootMachineUserRouteTestApp } from './machine-user-route-test-bootstrap.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner } = createMembershipTestHelpers({
  emailPrefix: 'rotation',
  orgNamePrefix: 'Rotation',
})

function machineUsersUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/machine-users`
}
function apiKeysUrl(machineUserId: string): string {
  return `/api/v1/machine-users/${machineUserId}/api-keys`
}
function rotateUrl(machineUserId: string, keyId: string): string {
  return `${apiKeysUrl(machineUserId)}/${keyId}/rotate`
}
function emergencyRevokeUrl(machineUserId: string, keyId: string): string {
  return `${apiKeysUrl(machineUserId)}/${keyId}/emergency-revoke`
}

async function setupMachineUserAndKey(
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
  const machineUserId = muRes.json<{ data: { id: string } }>().data.id
  const keyRes = await app.inject({
    method: 'POST',
    url: apiKeysUrl(machineUserId),
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: 'k' },
  })
  const keyBody = keyRes.json<{ data: { id: string; key: string } }>().data
  return { machineUserId, keyId: keyBody.id, key: keyBody.key }
}

async function exchangeToken(app: TestApp, key: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/machine-token',
    headers: { authorization: `Bearer ${key}` },
  })
}

describe('POST .../api-keys/:keyId/rotate', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootMachineUserRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  describe('AC-16: happy path', () => {
    it('issues a new key and sets overlapExpiresAt on the old key; both authenticate during overlap', async () => {
      const owner = await registerOwner(app, 'happy')
      const projectId = await createProjectViaApi(app, owner.cookies, 'rotation-happy')
      const {
        machineUserId,
        keyId,
        key: oldKey,
      } = await setupMachineUserAndKey(app, owner.cookies, projectId)

      const res = await app.inject({
        method: 'POST',
        url: rotateUrl(machineUserId, keyId),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { overlapMinutes: 240 },
      })

      expect(res.statusCode).toBe(201)
      const body = res.json<{
        data: { newKeyId: string; key: string; oldKeyId: string; overlapExpiresAt: string }
      }>().data
      expect(body.oldKeyId).toBe(keyId)
      expect(body.key).toMatch(/^pk_/)
      expect(new Date(body.overlapExpiresAt).getTime()).toBeGreaterThan(Date.now())

      const oldExchange = await exchangeToken(app, oldKey)
      const newExchange = await exchangeToken(app, body.key)
      expect(oldExchange.statusCode).toBe(200)
      expect(newExchange.statusCode).toBe(200)

      const [oldRow] = await withOrg(owner.orgId, (tx) =>
        tx.select().from(apiKeys).where(eq(apiKeys.id, keyId))
      )
      expect(oldRow?.revokedAt).toBeNull()
      expect(oldRow?.overlapExpiresAt).not.toBeNull()

      const auditRows = await withOrg(owner.orgId, (tx) =>
        tx
          .select()
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, 'machine_user.api_key_rotated'))
      )
      expect(auditRows.length).toBeGreaterThan(0)
      const payload = auditRows[0]?.payload as Record<string, unknown>
      expect(payload).toMatchObject({ oldKeyId: keyId, newKeyId: body.newKeyId })
      expect(JSON.stringify(payload)).not.toContain(body.key)
    })

    it('defaults overlapMinutes to 240 when omitted', async () => {
      const owner = await registerOwner(app, 'default-overlap')
      const projectId = await createProjectViaApi(app, owner.cookies, 'rotation-default')
      const { machineUserId, keyId } = await setupMachineUserAndKey(app, owner.cookies, projectId)

      const res = await app.inject({
        method: 'POST',
        url: rotateUrl(machineUserId, keyId),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: {},
      })
      expect(res.statusCode).toBe(201)
      const body = res.json<{ data: { overlapExpiresAt: string } }>().data
      const minutesAhead = (new Date(body.overlapExpiresAt).getTime() - Date.now()) / 60_000
      expect(minutesAhead).toBeGreaterThan(230)
      expect(minutesAhead).toBeLessThan(250)
    })
  })

  describe('AC-17: validation', () => {
    it('rejects overlapMinutes exceeding the 1440-minute cap', async () => {
      const owner = await registerOwner(app, 'over-cap')
      const projectId = await createProjectViaApi(app, owner.cookies, 'rotation-overcap')
      const { machineUserId, keyId } = await setupMachineUserAndKey(app, owner.cookies, projectId)

      const res = await app.inject({
        method: 'POST',
        url: rotateUrl(machineUserId, keyId),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { overlapMinutes: 1500 },
      })
      expect(res.statusCode).toBe(422)
    })

    it('rejects overlapMinutes of 0 or negative', async () => {
      const owner = await registerOwner(app, 'zero-negative')
      const projectId = await createProjectViaApi(app, owner.cookies, 'rotation-zeroneg')
      const { machineUserId, keyId } = await setupMachineUserAndKey(app, owner.cookies, projectId)

      const zeroRes = await app.inject({
        method: 'POST',
        url: rotateUrl(machineUserId, keyId),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { overlapMinutes: 0 },
      })
      expect(zeroRes.statusCode).toBe(422)

      const negRes = await app.inject({
        method: 'POST',
        url: rotateUrl(machineUserId, keyId),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { overlapMinutes: -5 },
      })
      expect(negRes.statusCode).toBe(422)
    })

    it('returns 404 for a nonexistent keyId', async () => {
      const owner = await registerOwner(app, 'not-found')
      const projectId = await createProjectViaApi(app, owner.cookies, 'rotation-notfound')
      const { machineUserId } = await setupMachineUserAndKey(app, owner.cookies, projectId)

      const res = await app.inject({
        method: 'POST',
        url: rotateUrl(machineUserId, randomUUID()),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: {},
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'api_key_not_found' })
    })

    it('returns 409 api_key_already_revoked when rotating an already-revoked key', async () => {
      const owner = await registerOwner(app, 'already-revoked')
      const projectId = await createProjectViaApi(app, owner.cookies, 'rotation-alreadyrevoked')
      const { machineUserId, keyId } = await setupMachineUserAndKey(app, owner.cookies, projectId)

      await app.inject({
        method: 'DELETE',
        url: `${apiKeysUrl(machineUserId)}/${keyId}`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })

      const res = await app.inject({
        method: 'POST',
        url: rotateUrl(machineUserId, keyId),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: {},
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'api_key_already_revoked' })
    })
  })

  describe('AC-26: concurrency', () => {
    it('exactly one of two concurrent rotate calls succeeds; the other gets 409 api_key_already_rotated', async () => {
      const owner = await registerOwner(app, 'concurrent')
      const projectId = await createProjectViaApi(app, owner.cookies, 'rotation-concurrent')
      const { machineUserId, keyId } = await setupMachineUserAndKey(app, owner.cookies, projectId)

      const [resA, resB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: rotateUrl(machineUserId, keyId),
          headers: { cookie: cookieHeader(owner.cookies) },
          payload: {},
        }),
        app.inject({
          method: 'POST',
          url: rotateUrl(machineUserId, keyId),
          headers: { cookie: cookieHeader(owner.cookies) },
          payload: {},
        }),
      ])

      const statuses = [resA.statusCode, resB.statusCode].sort()
      expect(statuses).toEqual([201, 409])
      const failed = resA.statusCode === 409 ? resA : resB
      expect(failed.json()).toMatchObject({ code: 'api_key_already_rotated' })
    })

    // 8-8 adversarial review AC-11: the same-action races above (rotate-vs-rotate,
    // emergency-revoke-vs-emergency-revoke) never exercise the cross-action combination — two
    // *different* mutation types racing on the same row via the shared `lockApiKeyForUpdate()`
    // lock. Confirms exactly one of the two succeeds and the loser gets a coherent 409, whichever
    // order the row lock is granted in.
    it('rotate racing an emergency-revoke on the same key: exactly one succeeds, the other 409s', async () => {
      const owner = await registerOwner(app, 'cross-action-concurrent')
      const projectId = await createProjectViaApi(app, owner.cookies, 'rotation-cross-concurrent')
      const { machineUserId, keyId } = await setupMachineUserAndKey(app, owner.cookies, projectId)

      const [rotateRes, emergencyRes] = await Promise.all([
        app.inject({
          method: 'POST',
          url: rotateUrl(machineUserId, keyId),
          headers: { cookie: cookieHeader(owner.cookies) },
          payload: {},
        }),
        app.inject({
          method: 'POST',
          url: emergencyRevokeUrl(machineUserId, keyId),
          headers: { cookie: cookieHeader(owner.cookies) },
        }),
      ])

      const successCodes = [rotateRes.statusCode, emergencyRes.statusCode].filter(
        (code) => code === 201 || code === 200
      )
      const failureCodes = [rotateRes.statusCode, emergencyRes.statusCode].filter(
        (code) => code === 409
      )
      expect(successCodes).toHaveLength(1)
      expect(failureCodes).toHaveLength(1)

      const failed = rotateRes.statusCode === 409 ? rotateRes : emergencyRes
      // Whichever request loses the row-lock race gets a 409 — the exact code depends on which
      // one committed first: if emergency-revoke wins, rotate sees revokedAt already set
      // (api_key_already_revoked); if rotate wins, emergency-revoke now sees overlapExpiresAt
      // already set (api_key_already_rotated, per this story's AC-11 fix above).
      expect(failed.json()).toMatchObject({
        code: expect.stringMatching(/^api_key_already_(revoked|rotated)$/),
      })

      const [row] = await withOrg(owner.orgId, (tx) =>
        tx.select().from(apiKeys).where(eq(apiKeys.id, keyId))
      )
      // Whichever action won, the old key ends up in exactly one terminal state — either
      // rotated (overlapExpiresAt set, revokedAt still null) or emergency-revoked (revokedAt
      // set) — never both/neither.
      expect(Boolean(row?.overlapExpiresAt) !== Boolean(row?.revokedAt)).toBe(true)
    })

    // 8-8 adversarial review AC-11 finding (was a real, reproducible gap — not just a
    // hypothetical race): `rotate` explicitly rejects an already-rotated key (409
    // api_key_already_rotated), but `emergency-revoke` had no symmetric check, so calling it on
    // a key that was already rotated (but is still inside its overlap window — revokedAt still
    // null) silently succeeded and issued a *second* successor key with no indication that a
    // rotation-issued successor already existed. Fixed below by mirroring rotate's own guard.
    it('returns 409 api_key_already_rotated when emergency-revoking an already-rotated key', async () => {
      const owner = await registerOwner(app, 'emergency-after-rotate')
      const projectId = await createProjectViaApi(app, owner.cookies, 'rotation-emergency-after')
      const { machineUserId, keyId } = await setupMachineUserAndKey(app, owner.cookies, projectId)

      const rotateRes = await app.inject({
        method: 'POST',
        url: rotateUrl(machineUserId, keyId),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: {},
      })
      expect(rotateRes.statusCode).toBe(201)

      const emergencyRes = await app.inject({
        method: 'POST',
        url: emergencyRevokeUrl(machineUserId, keyId),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(emergencyRes.statusCode).toBe(409)
      expect(emergencyRes.json()).toMatchObject({ code: 'api_key_already_rotated' })

      const [row] = await withOrg(owner.orgId, (tx) =>
        tx.select().from(apiKeys).where(eq(apiKeys.id, keyId))
      )
      expect(row?.revokedAt).toBeNull()
    })
  })
})

describe('POST .../api-keys/:keyId/emergency-revoke', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootMachineUserRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  describe('AC-20: atomic revoke + reissue', () => {
    it('revokes the old key immediately and issues a new one', async () => {
      const owner = await registerOwner(app, 'happy')
      const projectId = await createProjectViaApi(app, owner.cookies, 'emergency-happy')
      const {
        machineUserId,
        keyId,
        key: oldKey,
      } = await setupMachineUserAndKey(app, owner.cookies, projectId)

      const res = await app.inject({
        method: 'POST',
        url: emergencyRevokeUrl(machineUserId, keyId),
        headers: { cookie: cookieHeader(owner.cookies) },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json<{
        data: { revokedKeyId: string; newKey: string; newKeyId: string }
      }>().data
      expect(body.revokedKeyId).toBe(keyId)
      expect(body.newKey).toMatch(/^pk_/)

      const oldExchange = await exchangeToken(app, oldKey)
      expect(oldExchange.statusCode).toBe(401)
      const newExchange = await exchangeToken(app, body.newKey)
      expect(newExchange.statusCode).toBe(200)

      const auditRows = await withOrg(owner.orgId, (tx) =>
        tx
          .select()
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, 'machine_user.api_key_emergency_revoked'))
      )
      expect(auditRows.length).toBeGreaterThan(0)
      expect(auditRows[0]?.payload).toMatchObject({ revokedKeyId: keyId, newKeyId: body.newKeyId })
    })

    it('returns 409 api_key_already_revoked when called on an already-revoked key', async () => {
      const owner = await registerOwner(app, 'already-revoked')
      const projectId = await createProjectViaApi(app, owner.cookies, 'emergency-alreadyrevoked')
      const { machineUserId, keyId } = await setupMachineUserAndKey(app, owner.cookies, projectId)

      await app.inject({
        method: 'POST',
        url: emergencyRevokeUrl(machineUserId, keyId),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      const res = await app.inject({
        method: 'POST',
        url: emergencyRevokeUrl(machineUserId, keyId),
        headers: { cookie: cookieHeader(owner.cookies) },
      })

      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'api_key_already_revoked' })
    })
  })

  describe('AC-26: concurrency', () => {
    it('exactly one of two concurrent emergency-revoke calls succeeds', async () => {
      const owner = await registerOwner(app, 'concurrent')
      const projectId = await createProjectViaApi(app, owner.cookies, 'emergency-concurrent')
      const { machineUserId, keyId } = await setupMachineUserAndKey(app, owner.cookies, projectId)

      const [resA, resB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: emergencyRevokeUrl(machineUserId, keyId),
          headers: { cookie: cookieHeader(owner.cookies) },
        }),
        app.inject({
          method: 'POST',
          url: emergencyRevokeUrl(machineUserId, keyId),
          headers: { cookie: cookieHeader(owner.cookies) },
        }),
      ])

      const statuses = [resA.statusCode, resB.statusCode].sort()
      expect(statuses).toEqual([200, 409])
    })
  })
})
