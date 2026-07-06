import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, sessions } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { revokeSessionById } from './session-revoke.js'

// Production-code finding (Story 8.1 code review — discovered while root-causing why
// checkAuditActorTokenCoverage kept failing after fixing test-only helpers):
// writeSessionRevokedAudit() (session-revoke.ts) hardcoded `actorTokenId: null` for every
// SESSION_REVOKED audit row (logout, deactivation, admin_action, idle_expiry, security,
// account_recovery), regardless of whether the acting user has a real user_identity_tokens row.
// This is a live production bug, not test scaffolding: every real session revocation in the
// deployed app permanently violates the actor-token-coverage invariant
// (packages/db/src/check-audit-actor-token-coverage.ts), since audit_log_entries is append-only.
const { createApp, initVault } = await bootstrapRouteIntegrationTest()

describe('writeSessionRevokedAudit (via revokeSessionById)', () => {
  let app: Awaited<ReturnType<typeof createApp>>

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, 'session-revoke-audit-passphrase')
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it("records the acting user's real actor_token_id on the SESSION_REVOKED audit row, never null", async () => {
    const registered = await registerAndLoginViaApi(app, {
      email: `session-revoke-audit-${randomUUID()}@example.com`,
      password: 'correct-horse-battery-staple',
      orgName: `session-revoke-audit-${randomUUID()}`,
    })

    const sessionId = await withOrg(registered.orgId, async (tx) => {
      const rows = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, registered.userId))
        .orderBy(desc(sessions.createdAt))
        .limit(1)
      const row = rows[0]
      if (!row) throw new Error('expected a session row for the registered user')
      return row.id
    })

    await withOrg(registered.orgId, (tx) =>
      revokeSessionById(sessionId, {
        scope: 'logout',
        tx,
        actorUserId: registered.userId,
        expectedUserId: registered.userId,
        expectedOrgId: registered.orgId,
      })
    )

    const revokedRows = await withOrg(registered.orgId, (tx) =>
      tx
        .select({ actorTokenId: auditLogEntries.actorTokenId })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, AuditEvent.SESSION_REVOKED))
    )

    expect(revokedRows.length).toBeGreaterThan(0)
    for (const row of revokedRows) {
      expect(row.actorTokenId).not.toBeNull()
    }
  })
})
