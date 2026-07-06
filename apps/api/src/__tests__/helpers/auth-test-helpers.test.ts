import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { auditLogEntries, organizations } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
  mintOrgSessionCookies,
  registerAndLoginViaApi,
} from './auth-test-helpers.js'
import { resetVaultForTest } from './vault-test-cleanup.js'

// Code-review finding (Story 8.1): mintOrgSessionCookies() hardcoded `identityTokenId: null` when
// minting a second-org session for an already-registered user (used by
// apps/api/src/modules/org/deactivation.routes.test.ts and
// apps/api/src/modules/auth/recovery.routes.test.ts), the same bug pattern fixed in
// loginExistingUserInOrg (org-role-test-helpers.ts). A null actor_token_id on an
// actor_type='human' SESSION_CREATED row permanently fails checkAuditActorTokenCoverage
// (packages/db/src/check-audit-actor-token-coverage.ts), since audit_log_entries is append-only
// and never cleaned up between test runs.
const { createApp, initVault } = await bootstrapRouteIntegrationTest()

describe('mintOrgSessionCookies', () => {
  let app: Awaited<ReturnType<typeof createApp>>

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, 'auth-test-helpers-passphrase')
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it("never discards an already-registered user's real identity token when minting a second-org session", async () => {
    const registered = await registerAndLoginViaApi(app, {
      email: `auth-helper-existing-${randomUUID()}@example.com`,
      password: 'correct-horse-battery-staple',
      orgName: `auth-helper-existing-${randomUUID()}`,
    })

    const secondOrgId = randomUUID()
    await getDb()
      .insert(organizations)
      .values({
        id: secondOrgId,
        name: `auth-helper-second-${secondOrgId.slice(0, 8)}`,
        slug: `auth-helper-second-${secondOrgId.slice(0, 8)}`,
      })

    await mintOrgSessionCookies(app, registered.userId, secondOrgId)

    const rows = await withOrg(secondOrgId, (tx) =>
      tx
        .select({ actorTokenId: auditLogEntries.actorTokenId })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, AuditEvent.SESSION_CREATED))
    )

    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.actorTokenId).not.toBeNull()
    }
  })
})
