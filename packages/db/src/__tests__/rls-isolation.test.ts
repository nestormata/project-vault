import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { getDb, withOrg } from '../index.js'
import { withTestOrg } from '../test-helpers.js'
import {
  sessions,
  orgMemberships,
  securityAlerts,
  auditLogEntries,
  orgSsoDomains,
} from '../schema/index.js'

const TEST_SSO_PROVIDER = 'test.provider'

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

  // Story 14.4 AC-5/Task 1.2: org_sso_domains is org-scoped like external_identities — a row in
  // org A must be invisible via withOrg(orgB, ...), same RLS policy pattern as every other
  // org-scoped table above. (The pre-auth domain-lookup route itself bypasses RLS entirely via
  // getAdminDb() — see domain-lookup-routes.ts — but every other access path must stay isolated.)
  it('isolates org_sso_domains rows by org', async () => {
    await withTestOrg(async ({ orgId: orgAId }) => {
      await withTestOrg(async ({ orgId: orgBId }) => {
        await withOrg(orgAId, (tx) =>
          tx.insert(orgSsoDomains).values({
            orgId: orgAId,
            domain: `org-a-${crypto.randomUUID()}.example`,
            providerName: TEST_SSO_PROVIDER,
          })
        )
        await withOrg(orgBId, (tx) =>
          tx.insert(orgSsoDomains).values({
            orgId: orgBId,
            domain: `org-b-${crypto.randomUUID()}.example`,
            providerName: TEST_SSO_PROVIDER,
          })
        )

        const orgARows = await withOrg(orgAId, (tx) => tx.select().from(orgSsoDomains))
        expect(orgARows).toHaveLength(1)
        expect(orgARows[0]?.orgId).toBe(orgAId)

        const orgBRows = await withOrg(orgBId, (tx) => tx.select().from(orgSsoDomains))
        expect(orgBRows).toHaveLength(1)
        expect(orgBRows[0]?.orgId).toBe(orgBId)
      })
    })
  })

  // Story 14.6 AC-1 edge case: the read-only test above (Story 14.4) already proves SELECT
  // isolation via getAdminDb()-free access paths; this adds the write-path proof the new admin
  // CRUD routes rely on — an UPDATE/DELETE issued under org B's RLS context must affect zero rows
  // of org A's mapping, even when org B supplies org A's real row id (the exact cross-org :id
  // guess shape org-sso-domains-routes.ts's PATCH/DELETE handlers guard against at the app layer;
  // this proves the guarantee also holds at the database/RLS layer itself, structurally, not just
  // because the route happens to filter by orgId).
  it('write-path isolation: org B cannot UPDATE or DELETE org A rows, even by guessing the real id', async () => {
    await withTestOrg(async ({ orgId: orgAId }) => {
      await withTestOrg(async ({ orgId: orgBId }) => {
        const [orgARow] = await withOrg(orgAId, (tx) =>
          tx
            .insert(orgSsoDomains)
            .values({
              orgId: orgAId,
              domain: `write-iso-a-${crypto.randomUUID()}.example`,
              providerName: TEST_SSO_PROVIDER,
            })
            .returning()
        )
        if (!orgARow) throw new Error('expected org A row to be inserted')
        const orgARowId = orgARow.id

        const updateResult = await withOrg(orgBId, (tx) =>
          tx
            .update(orgSsoDomains)
            .set({ providerName: 'hijacked.provider' })
            .where(sql`${orgSsoDomains.id} = ${orgARowId}`)
            .returning()
        )
        expect(updateResult).toHaveLength(0)

        const deleteResult = await withOrg(orgBId, (tx) =>
          tx
            .delete(orgSsoDomains)
            .where(sql`${orgSsoDomains.id} = ${orgARowId}`)
            .returning()
        )
        expect(deleteResult).toHaveLength(0)

        // The row is untouched: still present, still under org A, provider unchanged.
        const stillThere = await withOrg(orgAId, (tx) =>
          tx
            .select()
            .from(orgSsoDomains)
            .where(sql`${orgSsoDomains.id} = ${orgARowId}`)
        )
        expect(stillThere).toHaveLength(1)
        expect(stillThere[0]?.providerName).toBe(TEST_SSO_PROVIDER)
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
