import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { checkAuditActorTokenCoverage } from '@project-vault/db/check-audit-actor-token-coverage'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const PASSPHRASE = 'backfill-check-passphrase'
const { registerOwner, addUserToOrg } = createMembershipTestHelpers({
  emailPrefix: 'backfill-check',
  orgNamePrefix: 'Backfill Check',
})

const adminConnectionString =
  process.env['ADMIN_DATABASE_URL'] ?? 'postgresql://postgres:password@localhost:5432/project_vault'
const adminSql = postgres(adminConnectionString)

class RollbackTestTransaction extends Error {}

/**
 * Story 8.3 AC-23/AC-24 — re-runs Story 8.1's checkAuditActorTokenCoverage() against this
 * story's own new write paths (access-report's own audit write, pseudonymize's own audit write)
 * to confirm they introduce no new actor-token-coverage gap, closing the loop 8.1 opened.
 */
describe("checkAuditActorTokenCoverage — re-run for this story's own new event types (AC-23/AC-24)", () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('AC-23: reports zero gaps after this story exercises audit.access_report_generated and user.pseudonymized', async () => {
    const owner = await registerOwner(app, 'clean')
    const member = await addUserToOrg(app, owner.orgId, 'clean-member', { orgRole: 'member' })

    const reportRes = await app.inject({
      method: 'POST',
      url: '/api/v1/org/audit/access-report',
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: {},
    })
    expect(reportRes.statusCode).toBe(200)

    const pseudonymizeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/org/users/${member.userId}/pseudonymize`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { confirmUserId: member.userId },
    })
    expect(pseudonymizeRes.statusCode).toBe(200)

    await expect(checkAuditActorTokenCoverage(adminSql)).resolves.toBeUndefined()
  })

  it('AC-24: still reports a real gap when one exists (a corrupted human-actor row), rolled back after', async () => {
    let caught: unknown

    await adminSql
      .begin(async (tx) => {
        const orgId = randomUUID()
        await tx`
          INSERT INTO organizations (id, name, slug)
          VALUES (${orgId}, ${'backfill-dirty-test'}, ${'backfill-dirty-' + orgId.slice(0, 8)})
        `
        await tx`
          INSERT INTO audit_log_entries
            (org_id, actor_type, actor_token_id, event_type, key_version, hmac)
          VALUES
            (${orgId}, 'human', NULL, 'audit.access_report_generated', 1, ${'deadbeef'.repeat(8)})
        `
        try {
          await checkAuditActorTokenCoverage(tx)
        } catch (error) {
          caught = error
        }
        throw new RollbackTestTransaction('AC-24 fixture rollback — not a real failure')
      })
      .catch((error) => {
        if (!(error instanceof RollbackTestTransaction)) throw error
      })

    expect(caught).toBeDefined()
    expect((caught as Error).message).toContain('Audit actor-token coverage gap')

    await expect(checkAuditActorTokenCoverage(adminSql)).resolves.toBeUndefined()
  })

  it('AC-24 edge case (D11): a machine_user row with a null actor_token_id is NOT flagged', async () => {
    let caught: unknown

    await adminSql
      .begin(async (tx) => {
        const orgId = randomUUID()
        await tx`
          INSERT INTO organizations (id, name, slug)
          VALUES (${orgId}, ${'backfill-machine-test'}, ${'backfill-machine-' + orgId.slice(0, 8)})
        `
        await tx`
          INSERT INTO audit_log_entries
            (org_id, actor_type, actor_token_id, event_type, key_version, hmac)
          VALUES
            (${orgId}, 'machine_user', NULL, 'machine_user.api_key_issued', 1, ${'deadbeef'.repeat(8)})
        `
        try {
          await checkAuditActorTokenCoverage(tx)
        } catch (error) {
          caught = error
        }
        throw new RollbackTestTransaction('D11 fixture rollback — not a real failure')
      })
      .catch((error) => {
        if (!(error instanceof RollbackTestTransaction)) throw error
      })

    // D11 — machine-user rows always have a null actor_token_id by design (identified via the
    // separate machine_users table, never user_identity_tokens); this must NOT be flagged.
    expect(caught).toBeUndefined()
  })
})
