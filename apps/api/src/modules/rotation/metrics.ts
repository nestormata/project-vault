import { Counter, Gauge } from 'prom-client'
import { isNotNull, sql } from 'drizzle-orm'
import { credentialVersions } from '@project-vault/db/schema'
import { getAdminDb } from '../../lib/db.js'

export const ROTATION_INITIATIONS_TOTAL_METRIC_NAME = 'rotation_initiations_total'

export const rotationInitiationsTotal = new Counter({
  name: ROTATION_INITIATIONS_TOTAL_METRIC_NAME,
  help: 'Total number of rotation initiation attempts, labeled by outcome',
  labelNames: ['outcome'],
})

export const CREDENTIAL_VERSIONS_LOCKED_BY_ROTATION_METRIC_NAME =
  'credential_versions_locked_by_rotation_total'

// Periodic-query-backed gauge (not a per-request counter): reports the current count of
// credential_versions rows still exempted from retention purge by an in-progress rotation
// (AC-13/AC-19 — rotation_locked_at is set by this story but never cleared until Story 5.2/5.3
// ships, so this is the operational visibility into that self-acknowledged, indefinitely-lived
// gap). Follows the dbPoolConnectionsActive/vaultSealed collect()-backed Gauge pattern.
// Uses getAdminDb() (bypasses per-org RLS), same justification as
// workers/notification-inbox-purge.ts's cross-org scan — this is a platform-wide operational
// count, not a single tenant's view, and no app.current_org_id is set outside a request/job.
export const credentialVersionsLockedByRotationTotal = new Gauge({
  name: CREDENTIAL_VERSIONS_LOCKED_BY_ROTATION_METRIC_NAME,
  help: 'Number of credential_versions rows currently locked by an in-progress or stale-recovery rotation',
  async collect() {
    const [row] = await getAdminDb()
      .select({ count: sql<number>`count(*)` })
      .from(credentialVersions)
      .where(isNotNull(credentialVersions.rotationLockedAt))
    this.set(Number(row?.count ?? 0))
  },
})
