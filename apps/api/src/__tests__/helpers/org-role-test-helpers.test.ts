import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { auditLogEntries, organizations, userIdentityTokens } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
  registerAndLoginViaApi,
} from './auth-test-helpers.js'
import { resetVaultForTest } from './vault-test-cleanup.js'
import { createDirectAuthenticatedUser, loginExistingUserInOrg } from './org-role-test-helpers.js'

// Code-review finding (Story 8.1): createDirectAuthenticatedUser() / loginExistingUserInOrg()
// used to mint sessions with `identityTokenId: null`, so every audit row they produced
// (SESSION_CREATED, and anything the caller does afterward as that user) permanently violated
// the actor-token-coverage invariant (`actor_type = 'human' AND actor_token_id IS NULL`) that
// `checkAuditActorTokenCoverage` (packages/db/src/check-audit-actor-token-coverage.ts) enforces
// as a hard `make ci` gate. Because audit_log_entries is append-only (no test cleanup), every
// prior run of any of the 8+ test files using these helpers left a permanent gap row behind,
// causing the coverage check to fail against any reused local dev database.
const { createApp, initVault } = await bootstrapRouteIntegrationTest()

describe('org-role-test-helpers', () => {
  let app: Awaited<ReturnType<typeof createApp>>

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, 'org-role-test-helpers-passphrase')
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  async function sessionCreatedActorTokenIds(orgId: string): Promise<(string | null)[]> {
    const rows = await withOrg(orgId, (tx) =>
      tx
        .select({ actorTokenId: auditLogEntries.actorTokenId })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, AuditEvent.SESSION_CREATED))
    )
    return rows.map((row) => row.actorTokenId)
  }

  it('createDirectAuthenticatedUser mints a session backed by a real user_identity_tokens row', async () => {
    const direct = await createDirectAuthenticatedUser(
      app,
      'coverage-check',
      'member',
      'org-role-helper-test'
    )

    const actorTokenIds = await sessionCreatedActorTokenIds(direct.orgId)
    expect(actorTokenIds.length).toBeGreaterThan(0)
    for (const actorTokenId of actorTokenIds) {
      expect(actorTokenId).not.toBeNull()
    }

    const tokenId = actorTokenIds[0]
    if (!tokenId) throw new Error('expected a non-null actorTokenId')
    const tokenRows = await getDb()
      .select({ id: userIdentityTokens.id, userId: userIdentityTokens.userId })
      .from(userIdentityTokens)
      .where(eq(userIdentityTokens.id, tokenId))

    expect(tokenRows).toHaveLength(1)
    expect(tokenRows[0]?.userId).toBe(direct.userId)
  })

  it(
    "loginExistingUserInOrg never discards an already-registered user's real identity token " +
      '(mirrors the direct-call pattern used across credentials/rotation/onboarding/etc test files)',
    async () => {
      const registered = await registerAndLoginViaApi(app, {
        email: `org-role-helper-existing-${randomUUID()}@example.com`,
        password: 'correct-horse-battery-staple',
        orgName: `org-role-helper-existing-${randomUUID()}`,
      })

      // A second, bare/pre-existing org that this already-registered user is granted access to
      // directly (bypassing registration for that org) — exactly the credentials/rotation/etc
      // test pattern of logging an existing user into a second org as viewer/member/admin.
      const secondOrgId = randomUUID()
      await getDb()
        .insert(organizations)
        .values({
          id: secondOrgId,
          name: `org-role-helper-second-${secondOrgId.slice(0, 8)}`,
          slug: `org-role-helper-second-${secondOrgId.slice(0, 8)}`,
        })

      await loginExistingUserInOrg(app, {
        userId: registered.userId,
        orgId: secondOrgId,
        role: 'viewer',
      })

      const actorTokenIds = await sessionCreatedActorTokenIds(secondOrgId)
      expect(actorTokenIds.length).toBeGreaterThan(0)
      for (const actorTokenId of actorTokenIds) {
        expect(actorTokenId).not.toBeNull()
      }
    }
  )
})
