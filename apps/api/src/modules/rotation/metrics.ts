import { Counter, Gauge } from 'prom-client'
import { and, inArray, isNotNull, sql } from 'drizzle-orm'
import { credentialVersions, rotationChecklistItems, rotations } from '@project-vault/db/schema'
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

// Story 5.2 (AC-24) — one counter per checklist mutation outcome, plus a completions counter
// and a periodic-query-backed pending-work gauge, following the same label/collect() patterns
// already established above for rotation initiation.
export const ROTATION_CHECKLIST_CONFIRMATIONS_TOTAL_METRIC_NAME =
  'rotation_checklist_confirmations_total'
export const rotationChecklistConfirmationsTotal = new Counter({
  name: ROTATION_CHECKLIST_CONFIRMATIONS_TOTAL_METRIC_NAME,
  help: 'Total number of checklist-item confirm attempts, labeled by outcome',
  labelNames: ['outcome'],
})

export const ROTATION_CHECKLIST_FAILURES_TOTAL_METRIC_NAME = 'rotation_checklist_failures_total'
export const rotationChecklistFailuresTotal = new Counter({
  name: ROTATION_CHECKLIST_FAILURES_TOTAL_METRIC_NAME,
  help: 'Total number of checklist-item fail calls — the operational signal for rotation friction',
})

export const ROTATION_CHECKLIST_RETRIES_TOTAL_METRIC_NAME = 'rotation_checklist_retries_total'
export const rotationChecklistRetriesTotal = new Counter({
  name: ROTATION_CHECKLIST_RETRIES_TOTAL_METRIC_NAME,
  help: 'Total number of checklist-item retry attempts, labeled by outcome',
  labelNames: ['outcome'],
})

export const ROTATION_COMPLETIONS_TOTAL_METRIC_NAME = 'rotation_completions_total'
export const rotationCompletionsTotal = new Counter({
  name: ROTATION_COMPLETIONS_TOTAL_METRIC_NAME,
  help: 'Total number of rotation completion attempts, labeled by outcome',
  labelNames: ['outcome'],
})

export const ROTATION_CHECKLIST_ITEMS_PENDING_TOTAL_METRIC_NAME =
  'rotation_checklist_items_pending_total'
// Periodic-query-backed gauge (not a per-request counter) — current count of
// rotation_checklist_items rows still needing action across all in_progress rotations.
// Uses getAdminDb() (bypasses per-org RLS), same justification as the gauge above: this is a
// platform-wide operational count, not a single tenant's view.
export const rotationChecklistItemsPendingTotal = new Gauge({
  name: ROTATION_CHECKLIST_ITEMS_PENDING_TOTAL_METRIC_NAME,
  help: 'Number of rotation_checklist_items rows still unconfirmed/failed/max_retries_exceeded across in_progress rotations',
  async collect() {
    const [row] = await getAdminDb()
      .select({ count: sql<number>`count(*)` })
      .from(rotationChecklistItems)
      .innerJoin(rotations, sql`${rotations.id} = ${rotationChecklistItems.rotationId}`)
      .where(
        and(
          sql`${rotations.status} = 'in_progress'`,
          inArray(rotationChecklistItems.status, ['unconfirmed', 'failed', 'max_retries_exceeded'])
        )
      )
    this.set(Number(row?.count ?? 0))
  },
})

// Story 5.3 (AC-24) — break-glass/stale-recovery operational metrics, following the exact
// Counter/Gauge patterns established above by 5.1/5.2.
export const ROTATION_BREAK_GLASS_TOTAL_METRIC_NAME = 'rotation_break_glass_total'
export const rotationBreakGlassTotal = new Counter({
  name: ROTATION_BREAK_GLASS_TOTAL_METRIC_NAME,
  help: 'Total number of break-glass emergency rotation attempts, labeled by outcome',
  labelNames: ['outcome'],
})

export const ROTATION_STALE_DETECTIONS_TOTAL_METRIC_NAME = 'rotation_stale_detections_total'
// Incremented once per rotation transitioned to stale_recovery by the stale-detection job — the
// primary operational health signal for "how often do rotations go unattended".
export const rotationStaleDetectionsTotal = new Counter({
  name: ROTATION_STALE_DETECTIONS_TOTAL_METRIC_NAME,
  help: 'Total number of rotations transitioned to stale_recovery by the stale-detection job',
})

export const ROTATION_RESOLUTIONS_TOTAL_METRIC_NAME = 'rotation_resolutions_total'
export const rotationResolutionsTotal = new Counter({
  name: ROTATION_RESOLUTIONS_TOTAL_METRIC_NAME,
  help: 'Total number of stale_recovery rotations resolved, labeled by outcome (resumed/abandoned)',
  labelNames: ['outcome'],
})

export const ROTATION_BREAK_GLASS_OVERLAP_EXPIRATIONS_TOTAL_METRIC_NAME =
  'rotation_break_glass_overlap_expirations_total'
export const rotationBreakGlassOverlapExpirationsTotal = new Counter({
  name: ROTATION_BREAK_GLASS_OVERLAP_EXPIRATIONS_TOTAL_METRIC_NAME,
  help: 'Total number of credential_versions rows auto-retired by the break-glass overlap-expiry job',
})

// Story 5.5 AC-3: Story 5.3's own text calls the revealCurrentValue()/listVersionHistory()
// abandoned-version-exclusion change "the single highest-risk change" in that story — a hot-path
// change affecting every credential reveal in the system, not just rotation-touched ones. This
// counter (incremented from apps/api/src/modules/credentials/routes.ts, not this module — kept
// here to match every other rotation-adjacent metric's location/naming convention) is the
// production signal that would catch a regression in that filter before it silently breaks
// credential reveal at scale.
export const CREDENTIAL_REVEAL_ABANDONED_VERSION_EXCLUDED_TOTAL_METRIC_NAME =
  'credential_reveal_abandoned_version_excluded_total'
export const credentialRevealAbandonedVersionExcludedTotal = new Counter({
  name: CREDENTIAL_REVEAL_ABANDONED_VERSION_EXCLUDED_TOTAL_METRIC_NAME,
  help: 'Total number of revealCurrentValue() calls that excluded an abandoned (stale-recovery-abandoned or break-glass-superseded) version to serve an earlier one',
})

export const ROTATIONS_STALE_RECOVERY_PENDING_TOTAL_METRIC_NAME =
  'rotations_stale_recovery_pending_total'
// Periodic-query-backed gauge (not a per-request counter) — current count of rotations rows
// awaiting a human resume/abandon decision. Uses getAdminDb() (bypasses per-org RLS), same
// justification as the two gauges above: platform-wide operational count, not a single tenant's.
export const rotationsStaleRecoveryPendingTotal = new Gauge({
  name: ROTATIONS_STALE_RECOVERY_PENDING_TOTAL_METRIC_NAME,
  help: 'Number of rotations rows currently in stale_recovery, awaiting a human resume/abandon decision',
  async collect() {
    const [row] = await getAdminDb()
      .select({ count: sql<number>`count(*)` })
      .from(rotations)
      .where(sql`${rotations.status} = 'stale_recovery'`)
    this.set(Number(row?.count ?? 0))
  },
})
