import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { getDb, withPlatformOperatorContext } from '../index.js'
import { createTestUser, deleteTestUser } from '../test-helpers.js'

const adminConnectionString =
  process.env['ADMIN_DATABASE_URL'] ?? 'postgresql://postgres:password@localhost:5432/project_vault'
const adminSql = postgres(adminConnectionString)

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

describe('purge_expired_platform_audit_entries (Story 9.4 AC-17, D5)', () => {
  it(
    'still raises the append-only exception for a raw DELETE that never sets the ' +
      'platform_audit_retention_purge session flag',
    async () => {
      const userId = await createTestUser('platform-audit-purge-guard')
      try {
        await adminSql`
          INSERT INTO platform_audit_events (operator_id, action_type, key_version, hmac, payload)
          VALUES (${userId}, 'test.raw_delete_guard', 1, ${'a'.repeat(64)}, '{}'::jsonb)
        `
        await expect(
          adminSql`DELETE FROM platform_audit_events WHERE operator_id = ${userId}`
        ).rejects.toThrow(/append-only/)
      } finally {
        await tryDeleteTestUser(userId)
      }
    }
  )

  it('deletes exactly the rows older than the cutoff, platform-wide (happy path, AC-17 negative example: no caller-supplied filter beyond the cutoff)', async () => {
    const userId = await createTestUser('platform-audit-purge-happy')
    try {
      await adminSql`
        INSERT INTO platform_audit_events (operator_id, action_type, key_version, hmac, payload, created_at)
        VALUES
          (${userId}, 'test.old_row', 1, ${'a'.repeat(64)}, '{}'::jsonb, now() - interval '400 days'),
          (${userId}, 'test.new_row', 1, ${'b'.repeat(64)}, '{}'::jsonb, now())
      `

      const deletedCount = await getDb().transaction(async (tx) => {
        const rows = await tx.execute(
          sql`SELECT purge_expired_platform_audit_entries(now() - interval '365 days') AS deleted`
        )
        return (rows as unknown as { deleted: string }[])[0]?.deleted
      })
      expect(Number(deletedCount)).toBeGreaterThanOrEqual(1)

      const remaining = await withPlatformOperatorContext((tx) =>
        tx.execute(sql`SELECT action_type FROM platform_audit_events WHERE operator_id = ${userId}`)
      )
      const remainingTypes = (remaining as unknown as { action_type: string }[]).map(
        (row) => row.action_type
      )
      expect(remainingTypes).toContain('test.new_row')
      expect(remainingTypes).not.toContain('test.old_row')
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  it('does not disable the append-only guarantee after a purge call completes', async () => {
    await getDb().transaction((tx) =>
      tx.execute(sql`SELECT purge_expired_platform_audit_entries(now())`)
    )

    const userId = await createTestUser('platform-audit-purge-post')
    try {
      await adminSql`
        INSERT INTO platform_audit_events (operator_id, action_type, key_version, hmac, payload)
        VALUES (${userId}, 'test.post_purge_row', 1, ${'c'.repeat(64)}, '{}'::jsonb)
      `
      await expect(
        adminSql`DELETE FROM platform_audit_events WHERE operator_id = ${userId}`
      ).rejects.toThrow(/append-only/)
    } finally {
      await tryDeleteTestUser(userId)
    }
  })
})
