import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getDb } from '../index.js'

/**
 * Story 5.5 AC-8: `idx_rotations_status_initiated` (Story 5.3's migration) originally led with
 * `status` alone — no `org_id` leading column — even though the stale-detection job
 * (apps/api/src/workers/rotation-recover.ts) scans per-org via `fetchAllOrgIds()` +
 * `runOrgScopedJob()`, relying on RLS to filter each org's rows out of a single
 * tenant-agnostic index range. This asserts the migrated index's actual column order directly
 * against Postgres's catalog (`pg_indexes`) — a deterministic check that doesn't depend on the
 * query planner's row-count-sensitive choice between an Index Scan and a Seq Scan (which, on a
 * near-empty test table, would pick a Seq Scan regardless of which index exists — an
 * EXPLAIN-based assertion here would be flaky, not a real regression signal).
 */
describe('idx_rotations_status_initiated (Story 5.5 AC-8)', () => {
  it('leads with org_id, then status, then initiated_at', async () => {
    const [row] = await getDb().execute<{ indexdef: string }>(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_rotations_status_initiated'`
    )
    expect(row).toBeDefined()
    const indexdef = row?.indexdef ?? ''
    // e.g. "CREATE INDEX idx_rotations_status_initiated ON public.rotations USING btree
    // (org_id, status, initiated_at)"
    const columnList = indexdef.match(/\(([^)]+)\)\s*$/)?.[1] ?? ''
    const columns = columnList.split(',').map((c) => c.trim())
    expect(columns).toEqual(['org_id', 'status', 'initiated_at'])
  })
})
