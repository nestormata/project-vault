import { describe, expect, it } from 'vitest'
import { getTableColumns, sql } from 'drizzle-orm'
import { getDb, withOrg } from '../index.js'
import { auditLogEntries, extensionAuditIdempotencyKeys } from '../schema/index.js'
import { withTwoTestOrgs } from '../test-helpers.js'

const TABLE = 'extension_audit_idempotency_keys'
const EXTENSION = 'com.acme.fixture'

async function insertAuditRow(orgId: string): Promise<string> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(auditLogEntries)
      .values({
        orgId,
        actorType: 'extension',
        eventType: 'ext.com.acme.fixture.thing',
        keyVersion: 1,
        hmac: 'idem-schema-test',
      })
      .returning({ id: auditLogEntries.id })
  )
  return row?.id as string
}

// Story 71.1 AC-4 — schema/catalog pins plus cross-tenant isolation for the dedupe table.
describe('extension_audit_idempotency_keys schema and RLS', () => {
  it('has RLS enabled and forced, and an org policy', async () => {
    const rows = await getDb().execute(
      sql`SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
            FROM pg_class WHERE relname = ${TABLE} AND relkind = 'r'`
    )
    expect(rows[0]).toEqual({ enabled: true, forced: true })
    const policies = await getDb().execute(
      sql`SELECT cmd FROM pg_policies WHERE tablename = ${TABLE}`
    )
    expect(policies).toHaveLength(1)
    expect(policies[0]?.['cmd']).toBe('ALL')
  })

  it('grants vault_app SELECT and INSERT only', async () => {
    const privilege = async (name: string): Promise<boolean> => {
      const rows = await getDb().execute(
        sql`SELECT has_table_privilege('vault_app', ${TABLE}, ${name}) AS granted`
      )
      return rows[0]?.['granted'] === true
    }
    expect(await privilege('SELECT')).toBe(true)
    expect(await privilege('INSERT')).toBe(true)
    expect(await privilege('UPDATE')).toBe(false)
    expect(await privilege('DELETE')).toBe(false)
    expect(await privilege('TRUNCATE')).toBe(false)
  })

  it('has the composite primary key and stores a fingerprint, never a payload copy', async () => {
    const pk = await getDb().execute(
      sql`SELECT a.attname AS column_name
            FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
           WHERE i.indrelid = ${TABLE}::regclass AND i.indisprimary
           ORDER BY a.attname`
    )
    expect(pk.map((r) => r['column_name'])).toEqual(['extension_name', 'idempotency_key', 'org_id'])
    expect(Object.keys(getTableColumns(extensionAuditIdempotencyKeys)).sort()).toEqual([
      'auditEntryId',
      'contentFingerprint',
      'createdAt',
      'extensionName',
      'idempotencyKey',
      'orgId',
    ])
  })

  it('org B cannot see or collide with org A keys; raw query as org B returns zero rows', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      const auditA = await insertAuditRow(orgAId)
      const auditB = await insertAuditRow(orgBId)
      await withOrg(orgAId, (tx) =>
        tx.insert(extensionAuditIdempotencyKeys).values({
          orgId: orgAId,
          extensionName: EXTENSION,
          idempotencyKey: 'shared-key',
          contentFingerprint: 'fp-a',
          auditEntryId: auditA,
        })
      )
      const seenByB = await withOrg(orgBId, (tx) =>
        tx.execute(sql`SELECT 1 FROM extension_audit_idempotency_keys`)
      )
      expect(seenByB).toHaveLength(0)

      // The same key under org B is independent: no PK collision.
      await withOrg(orgBId, (tx) =>
        tx.insert(extensionAuditIdempotencyKeys).values({
          orgId: orgBId,
          extensionName: EXTENSION,
          idempotencyKey: 'shared-key',
          contentFingerprint: 'fp-b',
          auditEntryId: auditB,
        })
      )
      // Org A cannot write a row for org B (WITH CHECK).
      await expect(
        withOrg(orgAId, (tx) =>
          tx.insert(extensionAuditIdempotencyKeys).values({
            orgId: orgBId,
            extensionName: 'com.acme.other',
            idempotencyKey: 'k',
            contentFingerprint: 'fp',
            auditEntryId: auditB,
          })
        )
      ).rejects.toThrow()
    })
  })

  it('rejects UPDATE and DELETE for vault_app (append-only grants)', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      const auditA = await insertAuditRow(orgAId)
      await withOrg(orgAId, (tx) =>
        tx.insert(extensionAuditIdempotencyKeys).values({
          orgId: orgAId,
          extensionName: EXTENSION,
          idempotencyKey: 'append-only',
          contentFingerprint: 'fp',
          auditEntryId: auditA,
        })
      )
      await expect(
        withOrg(orgAId, (tx) =>
          tx.execute(sql`UPDATE extension_audit_idempotency_keys SET content_fingerprint = 'x'`)
        )
      ).rejects.toThrow()
      await expect(
        withOrg(orgAId, (tx) => tx.execute(sql`DELETE FROM extension_audit_idempotency_keys`))
      ).rejects.toThrow()
    })
  })
})
