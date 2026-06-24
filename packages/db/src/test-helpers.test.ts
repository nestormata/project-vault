import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { withTestOrg } from './test-helpers.js'
import { getDb, withOrg } from './index.js'
import { securityAlerts, auditLogEntries } from './schema/index.js'

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
