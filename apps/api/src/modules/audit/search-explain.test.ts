import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'

/**
 * AC-1's "practical scale note": epics.md cites 1M rows (NFR-PERF6), but seeding a literal 1M
 * rows in every CI run is impractical for suite runtime. This test seeds a representative volume
 * (below) sufficient to force the query planner off a sequential scan, and asserts an index scan
 * appears in EXPLAIN ANALYZE output for each single-dimension filter this story adds/relies on
 * (D5) — it is NOT a literal 1M-row timing benchmark, and should not be mistaken for one.
 *
 * No cleanup: matches this module's established convention (routes.test.ts's `registerOwner`)
 * of never deleting test orgs/audit rows — audit_log_entries is append-only in production and
 * this suite doesn't attempt to work around that for a throwaway perf-seeded org either.
 */
const SEEDED_ROW_COUNT = 20_000

describe('audit_log_entries query plans use indexed scans at seeded volume (AC-1, D5)', () => {
  let orgId: string

  beforeAll(async () => {
    orgId = randomUUID()
    const suffix = orgId.slice(0, 8)
    await getDb().execute(
      sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${'perf-org-' + suffix}, ${'perf-' + suffix})`
    )
    await withOrg(orgId, (tx) =>
      tx.execute(sql`
        INSERT INTO audit_log_entries (org_id, actor_type, event_type, resource_id, project_id, key_version, hmac)
        SELECT
          ${orgId},
          'system',
          'perf.event.' || (n % 50),
          gen_random_uuid(),
          NULL,
          1,
          md5(n::text)
        FROM generate_series(1, ${SEEDED_ROW_COUNT}) AS n
      `)
    )
  }, 60_000)

  it('uses an index scan for an eventType-only filter', async () => {
    const rows = await withOrg(orgId, (tx) =>
      tx.execute(
        sql`EXPLAIN ANALYZE SELECT * FROM audit_log_entries WHERE event_type = 'perf.event.7' ORDER BY created_at DESC LIMIT 20`
      )
    )
    const plan = (rows as unknown as { 'QUERY PLAN': string }[])
      .map((r) => r['QUERY PLAN'])
      .join('\n')
    expect(plan).toMatch(/Index( Only)? Scan|Bitmap (Heap|Index) Scan/)
  }, 20_000)

  it('uses an index scan for a resourceId-only filter', async () => {
    const sampleRows = (await withOrg(orgId, (tx) =>
      tx.execute(sql`SELECT resource_id FROM audit_log_entries WHERE org_id = ${orgId} LIMIT 1`)
    )) as unknown as { resource_id: string }[]
    const sampleResourceId = sampleRows[0]?.resource_id
    expect(sampleResourceId).toBeTruthy()

    const rows = await withOrg(orgId, (tx) =>
      tx.execute(
        sql`EXPLAIN ANALYZE SELECT * FROM audit_log_entries WHERE resource_id = ${sampleResourceId} ORDER BY created_at DESC LIMIT 20`
      )
    )
    const plan = (rows as unknown as { 'QUERY PLAN': string }[])
      .map((r) => r['QUERY PLAN'])
      .join('\n')
    expect(plan).toMatch(/Index( Only)? Scan|Bitmap (Heap|Index) Scan/)
  }, 20_000)
})
