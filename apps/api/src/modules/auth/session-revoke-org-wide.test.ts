import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import {
  apiKeys,
  auditLogEntries,
  machineUsers,
  refreshTokens,
  revokedTokens,
  sessions,
} from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import {
  bootstrapRouteIntegrationTest,
  createProjectViaApi as createProject,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootProjectRouteTestApp } from '../projects/project-route-test-bootstrap.js'
import { revokeAllSessionsForOrg } from './session-revoke.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
const { auditStorageQuotaConfig } = await import('@project-vault/db/schema')

type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner, addUserToOrg, uniqueEmail } = createMembershipTestHelpers({
  emailPrefix: 'orgwide',
  orgNamePrefix: 'OrgWide',
})

/** Like registerOwner, but also returns the owner's email (needed to log in a second time). */
async function registerOwnerWithEmail(app: TestApp, label: string) {
  const email = uniqueEmail(label)
  const owner = await registerAndLoginViaApi(app, {
    email,
    password: 'correct-horse-battery-staple',
    orgName: `OrgWide ${label} ${randomUUID()}`,
  })
  return { ...owner, email }
}

async function loginAgain(app: TestApp, email: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: 'correct-horse-battery-staple' },
  })
  if (res.statusCode !== 200) {
    throw new Error(`login failed: ${res.statusCode} ${JSON.stringify(res.json())}`)
  }
}

async function activeSessionRows(orgId: string) {
  return withOrg(orgId, (tx) =>
    tx
      .select({ id: sessions.id, userId: sessions.userId, sessionVersion: sessions.sessionVersion })
      .from(sessions)
      .where(and(eq(sessions.orgId, orgId), isNull(sessions.revokedAt)))
  )
}

async function allSessionRows(orgId: string) {
  return withOrg(orgId, (tx) =>
    tx
      .select({
        id: sessions.id,
        revokedAt: sessions.revokedAt,
        sessionVersion: sessions.sessionVersion,
      })
      .from(sessions)
      .where(eq(sessions.orgId, orgId))
  )
}

async function createActiveApiKey(orgId: string, projectId: string, createdBy: string) {
  return withOrg(orgId, async (tx) => {
    const [mu] = await tx
      .insert(machineUsers)
      .values({ orgId, projectId, name: `svc-${randomUUID()}`, role: 'member', createdBy })
      .returning({ id: machineUsers.id })
    if (!mu) throw new Error('machine user insert failed')
    const [key] = await tx
      .insert(apiKeys)
      .values({
        orgId,
        machineUserId: mu.id,
        name: `key-${randomUUID()}`,
        keyHash: randomUUID(),
      })
      .returning({ id: apiKeys.id })
    if (!key) throw new Error('api key insert failed')
    return key.id
  })
}

describe.sequential('revokeAllSessionsForOrg (Story 31.1 AC4/AC5/AC9/AC11/AC12)', () => {
  let app: TestApp
  let previousQuotaEnforcement: boolean

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
    // AC11.36's rollback test needs the audit quota gate actually enforcing. Mutating the
    // already-imported `env` singleton directly (rather than process.env + a module reset, which
    // would fork the module graph into two separate vault/key-service instances) mirrors
    // prune-credential-versions.test.ts's established pattern for this exact situation.
    const { env } = await import('../../config/env.js')
    previousQuotaEnforcement = env.AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED
    Object.assign(env, { AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED: true })
  })

  afterAll(async () => {
    const { env } = await import('../../config/env.js')
    Object.assign(env, { AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED: previousQuotaEnforcement })
    await app.close()
    await resetVaultForTest()
  })

  it('AC4.14: revokes every active session across multiple users in one call', async () => {
    const owner = await registerOwnerWithEmail(app, 'fanout-owner')
    const jordan = await addUserToOrg(app, owner.orgId, 'fanout-jordan')
    const sam = await addUserToOrg(app, owner.orgId, 'fanout-sam')

    // owner already has 1 session from registerOwnerWithEmail's login; jordan/sam each have 1
    // from addUserToOrg's mintOrgSessionCookies. jordan/sam both have MFA enrolled (addUserToOrg
    // calls enrollMfa), so a repeat password login for either would only reach an MFA challenge,
    // not a new session — repeat-login the (non-MFA-enrolled) owner twice more instead, for a
    // total of 5 active sessions across the 3 users.
    await loginAgain(app, owner.email)
    await loginAgain(app, owner.email)

    const before = await activeSessionRows(owner.orgId)
    expect(before.length).toBe(5)

    const result = await revokeAllSessionsForOrg({
      orgId: owner.orgId,
      requestId: randomUUID(),
    })

    expect(result.sessionsRevokedCount).toBe(5)
    const after = await activeSessionRows(owner.orgId)
    expect(after).toHaveLength(0)

    // Every revoked session's refresh token is also revoked, and a revoked_tokens row exists.
    const refreshRows = await getDb()
      .select({ revokedAt: refreshTokens.revokedAt })
      .from(refreshTokens)
      .where(eq(refreshTokens.orgId, owner.orgId))
    expect(refreshRows.length).toBeGreaterThanOrEqual(5)
    for (const row of refreshRows) expect(row.revokedAt).not.toBeNull()

    const revokedRows = await getDb()
      .select({ jti: revokedTokens.jti })
      .from(revokedTokens)
      .where(eq(revokedTokens.userId, owner.userId))
    expect(revokedRows.length).toBeGreaterThanOrEqual(1)

    void jordan
    void sam
  })

  it('AC4.15: an org with zero active sessions returns 0, not an error', async () => {
    const owner = await registerOwner(app, 'fanout-empty')
    await revokeAllSessionsForOrg({ orgId: owner.orgId, requestId: randomUUID() })

    const result = await revokeAllSessionsForOrg({ orgId: owner.orgId, requestId: randomUUID() })
    expect(result.sessionsRevokedCount).toBe(0)
    expect(result.apiKeysRevokedCount).toBe(0)
  })

  it('AC4.16: already-revoked sessions are not double-processed', async () => {
    const owner = await registerOwner(app, 'fanout-skip')
    const first = await revokeAllSessionsForOrg({ orgId: owner.orgId, requestId: randomUUID() })
    expect(first.sessionsRevokedCount).toBeGreaterThanOrEqual(1)

    const rows = await allSessionRows(owner.orgId)
    const versionsAfterFirst = new Map(rows.map((r) => [r.id, r.sessionVersion]))

    const second = await revokeAllSessionsForOrg({ orgId: owner.orgId, requestId: randomUUID() })
    expect(second.sessionsRevokedCount).toBe(0)

    const rowsAfterSecond = await allSessionRows(owner.orgId)
    for (const row of rowsAfterSecond) {
      expect(row.sessionVersion).toBe(versionsAfterFirst.get(row.id))
    }
  })

  it('AC5.18: leaves another org fully untouched (tenant isolation)', async () => {
    const orgA = await registerOwner(app, 'iso-a')
    const orgB = await registerOwnerWithEmail(app, 'iso-b')
    await loginAgain(app, orgB.email)

    const orgBBefore = await allSessionRows(orgB.orgId)

    await revokeAllSessionsForOrg({ orgId: orgA.orgId, requestId: randomUUID() })

    const orgBAfter = await allSessionRows(orgB.orgId)
    expect(orgBAfter).toEqual(orgBBefore)
    for (const row of orgBAfter) {
      expect(row.revokedAt).toBeNull()
    }
  })

  it('AC7.24/AC7.25: writes exactly one audit row per call, including at zero counts', async () => {
    const owner = await registerOwner(app, 'audit-zero')
    const requestId = randomUUID()

    const result = await revokeAllSessionsForOrg({ orgId: owner.orgId, requestId })
    expect(result.sessionsRevokedCount).toBeGreaterThanOrEqual(1)

    const rows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload, eventType: auditLogEntries.eventType })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, AuditEvent.ORG_SESSIONS_REVOKED_BY_SERVICE))
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toMatchObject({ requestId, triggeredBy: 'centralizeme' })

    // Second call: zero counts, still writes a second audit row (always-write, AC7.25).
    const requestId2 = randomUUID()
    const second = await revokeAllSessionsForOrg({ orgId: owner.orgId, requestId: requestId2 })
    expect(second.sessionsRevokedCount).toBe(0)
    expect(second.apiKeysRevokedCount).toBe(0)

    const rows2 = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, AuditEvent.ORG_SESSIONS_REVOKED_BY_SERVICE))
    )
    expect(rows2).toHaveLength(2)
  })

  it('AC12.40/41/43: bulk-revokes active machine-user API keys, leaves keys/machine users otherwise intact', async () => {
    const owner = await registerOwner(app, 'apikeys')
    const projectId = await createProject(app, owner.cookies, 'apikeys-project')
    const key1 = await createActiveApiKey(owner.orgId, projectId, owner.userId)
    const key2 = await createActiveApiKey(owner.orgId, projectId, owner.userId)

    const result = await revokeAllSessionsForOrg({ orgId: owner.orgId, requestId: randomUUID() })
    expect(result.apiKeysRevokedCount).toBe(2)

    const rows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
        .from(apiKeys)
        .where(eq(apiKeys.orgId, owner.orgId))
    )
    expect(rows.filter((r) => r.id === key1 || r.id === key2)).toHaveLength(2)
    for (const row of rows) expect(row.revokedAt).not.toBeNull()

    const muRows = await withOrg(owner.orgId, (tx) =>
      tx.select({ deactivatedAt: machineUsers.deactivatedAt }).from(machineUsers)
    )
    for (const row of muRows) expect(row.deactivatedAt).toBeNull()
  })

  it('AC12.41: zero active API keys returns apiKeysRevokedCount 0', async () => {
    const owner = await registerOwner(app, 'apikeys-zero')
    const result = await revokeAllSessionsForOrg({ orgId: owner.orgId, requestId: randomUUID() })
    expect(result.apiKeysRevokedCount).toBe(0)
  })

  it('AC12.42: an already-revoked API key is not double-counted', async () => {
    const owner = await registerOwner(app, 'apikeys-skip')
    const projectId = await createProject(app, owner.cookies, 'apikeys-skip-project')
    await createActiveApiKey(owner.orgId, projectId, owner.userId)

    const first = await revokeAllSessionsForOrg({ orgId: owner.orgId, requestId: randomUUID() })
    expect(first.apiKeysRevokedCount).toBe(1)

    const second = await revokeAllSessionsForOrg({ orgId: owner.orgId, requestId: randomUUID() })
    expect(second.apiKeysRevokedCount).toBe(0)
  })

  it('AC11.36: an exhausted audit quota rolls back the entire transaction — nothing is revoked', async () => {
    const owner = await registerOwner(app, 'rollback')
    await withOrg(owner.orgId, (tx) =>
      tx
        .insert(auditStorageQuotaConfig)
        .values({ orgId: owner.orgId, quotaBytes: 1, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: auditStorageQuotaConfig.orgId,
          set: { quotaBytes: 1, updatedAt: new Date() },
        })
    )

    const before = await allSessionRows(owner.orgId)
    expect(before.length).toBeGreaterThanOrEqual(1)

    await expect(
      revokeAllSessionsForOrg({ orgId: owner.orgId, requestId: randomUUID() })
    ).rejects.toMatchObject({ code: 'audit_quota_exhausted' })

    const after = await allSessionRows(owner.orgId)
    expect(after).toEqual(before)
    for (const row of after) expect(row.revokedAt).toBeNull()
  })

  it('AC11.37: the org-level advisory lock creates real mutual exclusion with createLoginSessionInTx', async () => {
    const owner = await registerOwner(app, 'lock-race')

    const EVENT_LOGIN_TX_START = 'login-tx-start'
    const EVENT_LOGIN_TX_LOCKED = 'login-tx-locked'
    const EVENT_LOGIN_TX_COMMIT = 'login-tx-commit'
    const EVENT_REVOKE_DONE = 'revoke-done'
    const events: string[] = []
    let releaseLoginTx: (() => void) | undefined

    // Start a login transaction that acquires the lock and holds it open until released.
    const { withOrg: withOrgFn } = await import('@project-vault/db')
    const { createLoginSessionInTx } = await import('./service.js')
    const { firstActorTokenIdForUser } = await import('../audit/actor-token.js')
    const loginHeldOpen = withOrgFn(owner.orgId, async (tx) => {
      events.push(EVENT_LOGIN_TX_START)
      // Resolve the real identityTokenId (mirrors mintOrgSessionCookies' own established
      // pattern) rather than hardcoding null — a null actor_token_id on an actor_type='human'
      // audit row is a genuine, permanently-unfixable coverage gap (audit_log_entries is
      // append-only), not a harmless test shortcut.
      const identityTokenId = await firstActorTokenIdForUser(tx, owner.userId)
      await createLoginSessionInTx(tx, { id: owner.userId, identityTokenId }, owner.orgId, {})
      events.push(EVENT_LOGIN_TX_LOCKED)
      await new Promise<void>((resolve) => {
        releaseLoginTx = resolve
      })
      events.push(EVENT_LOGIN_TX_COMMIT)
    })

    // Give the login transaction a moment to acquire the lock and block on the promise above.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(events).toEqual([EVENT_LOGIN_TX_START, EVENT_LOGIN_TX_LOCKED])

    const revokePromise = revokeAllSessionsForOrg({
      orgId: owner.orgId,
      requestId: randomUUID(),
    }).then((result) => {
      events.push(EVENT_REVOKE_DONE)
      return result
    })

    // The revocation should still be blocked shortly after — the login transaction hasn't
    // released the lock yet.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(events).not.toContain(EVENT_REVOKE_DONE)

    releaseLoginTx?.()
    await loginHeldOpen
    const result = await revokePromise

    // The login committed (and its session is caught by the revocation's WHERE org_id = ? AND
    // revoked_at IS NULL bulk UPDATE, since it queries current DB state after acquiring its own
    // lock) before the revocation's lock-protected statements ran.
    expect(events.indexOf(EVENT_LOGIN_TX_COMMIT)).toBeLessThan(events.indexOf(EVENT_REVOKE_DONE))
    expect(result.sessionsRevokedCount).toBeGreaterThanOrEqual(1)

    const after = await activeSessionRows(owner.orgId)
    expect(after).toHaveLength(0)
  })
})
