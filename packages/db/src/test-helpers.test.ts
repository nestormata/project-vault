import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { createTestUser, deleteTestUser, insertTestProject, withTestOrg } from './test-helpers.js'
import { getDb, withOrg } from './index.js'
import { projects, securityAlerts, auditLogEntries, userIdentityTokens } from './schema/index.js'

describe('withTestOrg', () => {
  it('calls fn with a valid orgId and a usable tx', async () => {
    const result = await withTestOrg(async ({ orgId, tx }) => {
      expect(orgId).toMatch(/^[0-9a-f-]{36}$/)
      const [row] = await tx.execute(
        sql`SELECT id, name, slug FROM organizations WHERE id = ${orgId}`
      )
      const typed = row as { id: string; name: string; slug: string } | undefined
      expect(typed?.id).toBe(orgId)
      const suffix = orgId.slice(0, 8)
      expect(typed?.name).toBe(`test-org-${suffix}`)
      expect(typed?.slug).toBe(`test-${suffix}`)
      return orgId
    })
    expect(result).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('returns the fn result', async () => {
    const result = await withTestOrg(async () => 42)
    expect(result).toBe(42)
  })

  it('cleans up the test org even when fn throws', async () => {
    let capturedOrgId = ''
    await expect(
      withTestOrg(async ({ orgId }) => {
        capturedOrgId = orgId
        throw new Error('intentional test failure')
      })
    ).rejects.toThrow('intentional test failure')

    const rows = await getDb().execute(
      sql`SELECT id FROM organizations WHERE id = ${capturedOrgId}`
    )
    expect(rows).toHaveLength(0)
  })

  it('deletes security_alerts and audit_log_entries rows created during the test', async () => {
    let capturedOrgId = ''
    await withTestOrg(async ({ orgId }) => {
      capturedOrgId = orgId
      await withOrg(orgId, (tx) =>
        tx.insert(securityAlerts).values({ orgId, alertType: 'test', severity: 'info' })
      )
    })

    const alerts = await getDb().execute(
      sql`SELECT id FROM security_alerts WHERE org_id = ${capturedOrgId}`
    )
    expect(alerts).toHaveLength(0)

    const orgRows = await getDb().execute(
      sql`SELECT id FROM organizations WHERE id = ${capturedOrgId}`
    )
    expect(orgRows).toHaveLength(0)
  })

  it('leaves the org row in place when audit_log_entries were written (append-only, cannot be deleted)', async () => {
    let capturedOrgId = ''
    await withTestOrg(async ({ orgId }) => {
      capturedOrgId = orgId
      await withOrg(orgId, (tx) =>
        tx.insert(auditLogEntries).values({
          orgId,
          actorType: 'system',
          eventType: 'user.login',
          keyVersion: 1,
          hmac: 'cleanup-test-hmac',
        })
      )
    })

    const orgRows = await getDb().execute(
      sql`SELECT id FROM organizations WHERE id = ${capturedOrgId}`
    )
    expect(orgRows).toHaveLength(1)
  })
})

describe('createTestUser', () => {
  // Story 8.1 (check-audit-actor-token-coverage) treats a human-actor audit_log_entries row
  // with no actor_token_id as a permanent, unrepairable gap (the table is append-only). Many
  // test files pair createTestUser with a real login helper (e.g. loginExistingUserInOrg),
  // which writes a genuine SESSION_CREATED audit row. createTestUser must mint a
  // user_identity_tokens row — mirroring what the production registration flow
  // (auth/service.ts's registerUser) does in the same transaction — so that any subsequent
  // login for this user has a real token to attribute the audit row to.
  it('creates a corresponding user_identity_tokens row for the new user', async () => {
    const userId = await createTestUser('identity-token-coverage')
    try {
      const rows = await getDb()
        .select({ id: userIdentityTokens.id, userId: userIdentityTokens.userId })
        .from(userIdentityTokens)
        .where(eq(userIdentityTokens.userId, userId))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.userId).toBe(userId)
    } finally {
      await deleteTestUser(userId)
    }
  })
})

describe('insertTestProject', () => {
  it('inserts a project with default tags under org RLS', async () => {
    const userId = await createTestUser('insert-test-project')
    try {
      await withTestOrg(async ({ orgId }) => {
        const project = await insertTestProject(orgId, { userId, slug: 'payments' })
        expect(project.id).toMatch(/^[0-9a-f-]{36}$/)
        expect(project.tags).toEqual([])

        const rows = await withOrg(orgId, (tx) =>
          tx.select({ id: projects.id, tags: projects.tags }).from(projects)
        )
        expect(rows).toEqual([{ id: project.id, tags: [] }])
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
