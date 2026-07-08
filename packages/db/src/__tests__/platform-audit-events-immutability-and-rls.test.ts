import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { getDb, withPlatformOperatorContext, type Tx } from '../index.js'
import { createTestUser, deleteTestUser } from '../test-helpers.js'
import { platformAuditEvents } from '../schema/index.js'

// Only the table owner/superuser can actually re-GRANT a privilege (vault_app attempting its own
// re-grant is a silent no-op WARNING, not a real grant) — this dedicated admin connection is
// needed solely for the "trigger alone" regression test below.
const adminSql = postgres(
  process.env['ADMIN_DATABASE_URL'] ?? 'postgresql://postgres:password@localhost:5432/project_vault'
)

async function insertPlatformAuditRow(operatorId: string, hmac: string): Promise<string> {
  const [row] = await withPlatformOperatorContext((tx: Tx) =>
    tx
      .insert(platformAuditEvents)
      .values({ operatorId, actionType: 'test.action', keyVersion: 1, hmac })
      .returning()
  )
  return row?.id as string
}

// platform_audit_events.operator_id -> users.id has no ON DELETE CASCADE (an audit trail must
// never be silently destroyed by deleting the user it references) — a test user that ends up
// referenced by a (permanently un-deletable, append-only) audit row cannot be cleaned up
// afterward. Mirrors test-helpers.ts's own withTestOrg() cleanup precedent: attempt the delete,
// swallow only the expected FK-violation, leaving a harmless orphaned test fixture behind.
async function tryDeleteTestUser(userId: string): Promise<void> {
  try {
    await deleteTestUser(userId)
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined
    const isFkViolation =
      Boolean(cause) && typeof cause === 'object' && (cause as { code?: string }).code === '23503'
    if (!isFkViolation) throw error
  }
}

describe('platform_audit_events immutability (AC-2)', () => {
  it('allows INSERT', async () => {
    const userId = await createTestUser('platform-audit-insert')
    try {
      const id = await insertPlatformAuditRow(userId, 'test-hmac-insert')
      expect(id).toBeTruthy()
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  // Grant-layer REVOKE fires before the trigger (Postgres checks privileges first) — matches the
  // audit_log_entries precedent's assertion pattern exactly.
  it('throws "permission denied" on UPDATE (grant layer)', async () => {
    const userId = await createTestUser('platform-audit-update')
    try {
      const id = await insertPlatformAuditRow(userId, 'test-hmac-update')
      await expect(
        withPlatformOperatorContext((tx) =>
          tx
            .update(platformAuditEvents)
            .set({ hmac: 'tampered' })
            .where(eq(platformAuditEvents.id, id))
        )
      ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } })
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  it('throws "permission denied" on DELETE (grant layer)', async () => {
    const userId = await createTestUser('platform-audit-delete')
    try {
      const id = await insertPlatformAuditRow(userId, 'test-hmac-delete')
      await expect(
        withPlatformOperatorContext((tx) =>
          tx.delete(platformAuditEvents).where(eq(platformAuditEvents.id, id))
        )
      ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } })
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  // AC-2 edge case: even if a future migration accidentally re-grants UPDATE/DELETE, the trigger
  // alone must still block mutation. Re-grants inside a transaction that is rolled back at the
  // end of the test, so the real grant state is never actually changed.
  it('the trigger alone (grant re-granted, rolled back) still blocks UPDATE/DELETE', async () => {
    const userId = await createTestUser('platform-audit-trigger-only')
    try {
      const id = await insertPlatformAuditRow(userId, 'test-hmac-trigger')
      await expect(
        adminSql.begin(async (tx) => {
          await tx`GRANT UPDATE, DELETE ON platform_audit_events TO vault_app`
          await tx`UPDATE platform_audit_events SET hmac = 'tampered-2' WHERE id = ${id}`
          throw new Error('unreachable: trigger should have raised first')
        })
      ).rejects.toMatchObject({
        message: expect.stringMatching(/append-only: UPDATE and DELETE are forbidden/),
      })
    } finally {
      await tryDeleteTestUser(userId)
    }
  })
})

describe('platform_audit_events RLS (AC-3, AC-21)', () => {
  it('returns zero rows when app.platform_operator_verified is not set', async () => {
    const userId = await createTestUser('platform-audit-rls-unset')
    try {
      await insertPlatformAuditRow(userId, 'test-hmac-rls-unset')
      const rows = await getDb().transaction(async (tx) => {
        return tx.select().from(platformAuditEvents)
      })
      expect(rows.length).toBe(0)
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  it('returns rows once app.platform_operator_verified is set to true (transaction-scoped)', async () => {
    const userId = await createTestUser('platform-audit-rls-set')
    try {
      const id = await insertPlatformAuditRow(userId, 'test-hmac-rls-set')
      const rows = await withPlatformOperatorContext((tx) =>
        tx.select().from(platformAuditEvents).where(eq(platformAuditEvents.id, id))
      )
      expect(rows.length).toBe(1)
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  // AC-3 edge case: the session var MUST be transaction-scoped (SET LOCAL semantics via the
  // third `true` arg to set_config), not session-scoped — otherwise it would leak across pooled-
  // connection reuse. Two sequential unrelated transactions on the same underlying pooled
  // connection: the second, which never sets the variable, must see zero rows.
  it('does not leak app.platform_operator_verified across sequential transactions on a pooled connection', async () => {
    const userId = await createTestUser('platform-audit-rls-leak')
    try {
      const id = await insertPlatformAuditRow(userId, 'test-hmac-rls-leak')
      await withPlatformOperatorContext((tx) =>
        tx.select().from(platformAuditEvents).where(eq(platformAuditEvents.id, id))
      )
      const rowsAfter = await getDb().transaction(async (tx) => {
        return tx.select().from(platformAuditEvents).where(eq(platformAuditEvents.id, id))
      })
      expect(rowsAfter.length).toBe(0)
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  // AC-21: an ordinary org-scoped transaction (app.current_org_id set) never bleeds into
  // platform-operator visibility — the two contexts are orthogonal.
  it('an org-scoped transaction (app.current_org_id set) still sees zero platform_audit_events rows', async () => {
    const userId = await createTestUser('platform-audit-rls-org-scope')
    try {
      await insertPlatformAuditRow(userId, 'test-hmac-org-scope')
      const rows = await getDb().transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.current_org_id', gen_random_uuid()::text, true)`
        )
        return tx.select().from(platformAuditEvents)
      })
      expect(rows.length).toBe(0)
    } finally {
      await tryDeleteTestUser(userId)
    }
  })
})
