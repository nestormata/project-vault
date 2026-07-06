import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { withOrg } from '../index.js'
import { withTestOrg, withTwoTestOrgs } from '../test-helpers.js'

const adminConnectionString =
  process.env['ADMIN_DATABASE_URL'] ?? 'postgresql://postgres:password@localhost:5432/project_vault'
const adminSql = postgres(adminConnectionString)

/** Drizzle wraps the real Postgres error as `error.cause` — `.message` on the thrown error is
 * just "Failed query: ...". Matches the isAppendOnlyViolation pattern in test-helpers.ts. */
function causeMessage(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined
  return cause instanceof Error ? cause.message : String(error)
}

describe('purge_expired_audit_log_entries (D2, Story 8.2 AC-23)', () => {
  it(
    'still raises the append-only exception for a raw DELETE that never sets the ' +
      'audit_retention_purge session flag — the escape hatch is narrowly scoped, not a general ' +
      'loosening of the trigger',
    async () => {
      await withTestOrg(async ({ orgId }) => {
        await adminSql`
          INSERT INTO audit_log_entries (org_id, actor_type, event_type, key_version, hmac, payload)
          VALUES (${orgId}, 'system', 'test.raw_delete_guard', 1, ${'a'.repeat(64)}, '{}'::jsonb)
        `
        // Superuser bypasses table-grant REVOKEs (0002) but not the trigger itself — this
        // isolates the trigger's own logic from the separate grant-layer defense, proving the
        // trigger (not just the grant) still blocks an unsanctioned DELETE.
        await expect(
          adminSql`DELETE FROM audit_log_entries WHERE org_id = ${orgId}`
        ).rejects.toThrow(/append-only/)
      })
    }
  )

  it(
    'raises and deletes nothing when p_org_id does not match the session RLS org context ' +
      '(adversarial-review critical fix)',
    async () => {
      await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
        await adminSql`
          INSERT INTO audit_log_entries (org_id, actor_type, event_type, key_version, hmac, payload)
          VALUES (${orgAId}, 'system', 'test.org_mismatch', 1, ${'a'.repeat(64)}, '{}'::jsonb)
        `
        const beforeRows = await adminSql<{ count: string }[]>`
          SELECT count(*)::text FROM audit_log_entries WHERE org_id = ${orgAId}
        `
        const before = beforeRows[0]?.count

        // The transaction's RLS context is org B; calling the function with org A's id must be
        // refused, not silently trusted, even though vault_app has a broad EXECUTE grant.
        let caught: unknown
        try {
          await withOrg(orgBId, (tx) =>
            tx.execute(sql`SELECT purge_expired_audit_log_entries(${orgAId}::uuid, now())`)
          )
        } catch (error) {
          caught = error
        }
        expect(caught).toBeDefined()
        expect(causeMessage(caught)).toMatch(/does not match the session/)

        const afterRows = await adminSql<{ count: string }[]>`
          SELECT count(*)::text FROM audit_log_entries WHERE org_id = ${orgAId}
        `
        const after = afterRows[0]?.count
        expect(after).toBe(before)
      })
    }
  )

  it('deletes exactly the rows older than the cutoff for the matching org (happy path)', async () => {
    await withTestOrg(async ({ orgId }) => {
      await adminSql`
        INSERT INTO audit_log_entries (org_id, actor_type, event_type, key_version, hmac, payload, created_at)
        VALUES
          (${orgId}, 'system', 'test.old_row', 1, ${'a'.repeat(64)}, '{}'::jsonb, now() - interval '60 days'),
          (${orgId}, 'system', 'test.new_row', 1, ${'b'.repeat(64)}, '{}'::jsonb, now())
      `

      const deletedCount = await withOrg(orgId, async (tx) => {
        const rows = await tx.execute(
          sql`SELECT purge_expired_audit_log_entries(${orgId}::uuid, now() - interval '30 days') AS deleted`
        )
        return (rows as unknown as { deleted: string }[])[0]?.deleted
      })
      expect(Number(deletedCount)).toBe(1)

      const remaining = await adminSql<{ event_type: string }[]>`
        SELECT event_type FROM audit_log_entries WHERE org_id = ${orgId}
      `
      expect(remaining.map((row) => row.event_type)).toEqual(['test.new_row'])
    })
  })

  it('does not disable the append-only guarantee after a purge call completes', async () => {
    await withTestOrg(async ({ orgId }) => {
      await withOrg(orgId, (tx) =>
        tx.execute(sql`SELECT purge_expired_audit_log_entries(${orgId}::uuid, now())`)
      )

      // A fresh row inserted *after* the purge call — proves the session-local flag reset
      // (and the trigger's default-deny) still apply to subsequent, unrelated DELETEs.
      await adminSql`
        INSERT INTO audit_log_entries (org_id, actor_type, event_type, key_version, hmac, payload)
        VALUES (${orgId}, 'system', 'test.post_purge_row', 1, ${'c'.repeat(64)}, '{}'::jsonb)
      `

      await expect(adminSql`DELETE FROM audit_log_entries WHERE org_id = ${orgId}`).rejects.toThrow(
        /append-only/
      )
    })
  })
})
