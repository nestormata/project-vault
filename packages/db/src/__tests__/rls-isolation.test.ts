import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { getDb, withOrg } from '../index.js'
import { withTestOrg } from '../test-helpers.js'
import { sessions, orgMemberships, securityAlerts, auditLogEntries } from '../schema/index.js'

async function createTestUser(label: string): Promise<string> {
  const [user] = await getDb().execute(
    sql`INSERT INTO users (email, password_hash) VALUES (${`rls-${label}-${crypto.randomUUID()}@example.com`}, 'x') RETURNING id`
  )
  return (user as { id: string }).id
}

async function deleteTestUser(userId: string): Promise<void> {
  await getDb().execute(sql`DELETE FROM users WHERE id = ${userId}`)
}

describe('RLS cross-org isolation', () => {
  it('isolates sessions rows by org', async () => {
    const userId = await createTestUser('sessions')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withTestOrg(async ({ orgId: orgBId }) => {
          await withOrg(orgAId, (tx) =>
            tx.insert(sessions).values({
              userId,
              orgId: orgAId,
              jti: `rls-org-a-${crypto.randomUUID()}`,
              expiresAt: new Date(Date.now() + 3600_000),
            })
          )
          await withOrg(orgBId, (tx) =>
            tx.insert(sessions).values({
              userId,
              orgId: orgBId,
              jti: `rls-org-b-${crypto.randomUUID()}`,
              expiresAt: new Date(Date.now() + 3600_000),
            })
          )

          const orgARows = await withOrg(orgAId, (tx) => tx.select().from(sessions))
          expect(orgARows).toHaveLength(1)
          expect(orgARows[0]?.orgId).toBe(orgAId)

          const orgBRows = await withOrg(orgBId, (tx) => tx.select().from(sessions))
          expect(orgBRows).toHaveLength(1)
          expect(orgBRows[0]?.orgId).toBe(orgBId)
        })
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('isolates org_memberships rows by org', async () => {
    const userId = await createTestUser('members')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withTestOrg(async ({ orgId: orgBId }) => {
          await withOrg(orgAId, (tx) =>
            tx.insert(orgMemberships).values({ orgId: orgAId, userId, role: 'owner' })
          )
          await withOrg(orgBId, (tx) =>
            tx.insert(orgMemberships).values({ orgId: orgBId, userId, role: 'owner' })
          )

          const orgARows = await withOrg(orgAId, (tx) => tx.select().from(orgMemberships))
          expect(orgARows).toHaveLength(1)
          expect(orgARows[0]?.orgId).toBe(orgAId)

          const orgBRows = await withOrg(orgBId, (tx) => tx.select().from(orgMemberships))
          expect(orgBRows).toHaveLength(1)
          expect(orgBRows[0]?.orgId).toBe(orgBId)
        })
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('isolates security_alerts rows by org', async () => {
    await withTestOrg(async ({ orgId: orgAId }) => {
      await withTestOrg(async ({ orgId: orgBId }) => {
        await withOrg(orgAId, (tx) =>
          tx
            .insert(securityAlerts)
            .values({ orgId: orgAId, alertType: 'test_alert', severity: 'info' })
        )
        await withOrg(orgBId, (tx) =>
          tx
            .insert(securityAlerts)
            .values({ orgId: orgBId, alertType: 'test_alert', severity: 'info' })
        )

        const orgARows = await withOrg(orgAId, (tx) => tx.select().from(securityAlerts))
        expect(orgARows).toHaveLength(1)
        expect(orgARows[0]?.orgId).toBe(orgAId)

        const orgBRows = await withOrg(orgBId, (tx) => tx.select().from(securityAlerts))
        expect(orgBRows).toHaveLength(1)
        expect(orgBRows[0]?.orgId).toBe(orgBId)
      })
    })
  })

  it('isolates audit_log_entries rows by org', async () => {
    await withTestOrg(async ({ orgId: orgAId }) => {
      await withTestOrg(async ({ orgId: orgBId }) => {
        await withOrg(orgAId, (tx) =>
          tx.insert(auditLogEntries).values({
            orgId: orgAId,
            actorType: 'system',
            eventType: 'user.login',
            keyVersion: 1,
            hmac: 'test-hmac-a',
          })
        )
        await withOrg(orgBId, (tx) =>
          tx.insert(auditLogEntries).values({
            orgId: orgBId,
            actorType: 'system',
            eventType: 'user.login',
            keyVersion: 1,
            hmac: 'test-hmac-b',
          })
        )

        const orgARows = await withOrg(orgAId, (tx) => tx.select().from(auditLogEntries))
        expect(orgARows).toHaveLength(1)
        expect(orgARows[0]?.orgId).toBe(orgAId)

        const orgBRows = await withOrg(orgBId, (tx) => tx.select().from(auditLogEntries))
        expect(orgBRows).toHaveLength(1)
        expect(orgBRows[0]?.orgId).toBe(orgBId)
      })
    })
  })

  it('returns zero rows when querying without withOrg() context', async () => {
    const userId = await createTestUser('bare')
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrg(orgId, (tx) =>
          tx.insert(sessions).values({
            userId,
            orgId,
            jti: `rls-bare-${crypto.randomUUID()}`,
            expiresAt: new Date(Date.now() + 3600_000),
          })
        )

        const bareRows = await getDb().select().from(sessions)
        expect(bareRows).toHaveLength(0)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
