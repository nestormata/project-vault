import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { register as promRegister } from 'prom-client'
import { withOrg } from '@project-vault/db'
import {
  credentials,
  credentialVersions,
  projects,
  rotationChecklistItems,
  rotations,
} from '@project-vault/db/schema'
import { createTestUser, deleteTestUser, withTestOrg } from '@project-vault/db/test-helpers'
import {
  CREDENTIAL_VERSIONS_LOCKED_BY_ROTATION_METRIC_NAME,
  ROTATION_BREAK_GLASS_OVERLAP_EXPIRATIONS_TOTAL_METRIC_NAME,
  ROTATION_BREAK_GLASS_TOTAL_METRIC_NAME,
  ROTATION_CHECKLIST_CONFIRMATIONS_TOTAL_METRIC_NAME,
  ROTATION_CHECKLIST_FAILURES_TOTAL_METRIC_NAME,
  ROTATION_CHECKLIST_ITEMS_PENDING_TOTAL_METRIC_NAME,
  ROTATION_CHECKLIST_RETRIES_TOTAL_METRIC_NAME,
  ROTATION_COMPLETIONS_TOTAL_METRIC_NAME,
  ROTATION_INITIATIONS_TOTAL_METRIC_NAME,
  ROTATION_RESOLUTIONS_TOTAL_METRIC_NAME,
  ROTATION_STALE_DETECTIONS_TOTAL_METRIC_NAME,
  ROTATIONS_STALE_RECOVERY_PENDING_TOTAL_METRIC_NAME,
  rotationBreakGlassOverlapExpirationsTotal,
  rotationBreakGlassTotal,
  rotationChecklistConfirmationsTotal,
  rotationChecklistFailuresTotal,
  rotationChecklistRetriesTotal,
  rotationCompletionsTotal,
  rotationInitiationsTotal,
  rotationResolutionsTotal,
  rotationStaleDetectionsTotal,
} from './metrics.js'

const SUCCESS_OUTCOME_LINE = 'outcome="success"} 1'

async function insertTestProject(orgId: string): Promise<string> {
  const [project] = await withOrg(orgId, (tx) =>
    tx
      .insert(projects)
      .values({ orgId, name: 'Metrics Project', slug: `metrics-${randomUUID()}` })
      .returning({ id: projects.id })
  )
  if (!project) throw new Error('expected test project to be inserted')
  return project.id
}

async function insertTestCredential(orgId: string, projectId: string): Promise<string> {
  const [credential] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentials)
      .values({ orgId, projectId, name: 'Metrics Credential' })
      .returning({ id: credentials.id })
  )
  if (!credential) throw new Error('expected test credential to be inserted')
  return credential.id
}

/** Shared by the pending-checklist-items and stale-recovery gauge tests: both need a rotation
 *  (in a given status) referencing a freshly inserted credential version. */
async function insertTestRotation(
  orgId: string,
  projectId: string,
  credentialId: string,
  status: string
): Promise<string> {
  const [version] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentialVersions)
      .values({ orgId, credentialId, versionNumber: 1 })
      .returning({ id: credentialVersions.id })
  )
  if (!version) throw new Error('expected credential version insert')
  const [rotation] = await withOrg(orgId, (tx) =>
    tx
      .insert(rotations)
      .values({
        orgId,
        projectId,
        credentialId,
        newVersionId: version.id,
        previousVersionId: version.id,
        status,
      })
      .returning({ id: rotations.id })
  )
  if (!rotation) throw new Error('expected rotation insert')
  return rotation.id
}

describe('rotation metrics', () => {
  afterEach(() => {
    rotationInitiationsTotal.reset()
    rotationChecklistConfirmationsTotal.reset()
    rotationChecklistFailuresTotal.reset()
    rotationChecklistRetriesTotal.reset()
    rotationCompletionsTotal.reset()
    rotationBreakGlassTotal.reset()
    rotationStaleDetectionsTotal.reset()
    rotationResolutionsTotal.reset()
    rotationBreakGlassOverlapExpirationsTotal.reset()
  })

  it('increments rotation_initiations_total labeled by outcome', async () => {
    rotationInitiationsTotal.inc({ outcome: 'success' })
    rotationInitiationsTotal.inc({ outcome: 'conflict' })
    const metric = await promRegister.getSingleMetricAsString(
      ROTATION_INITIATIONS_TOTAL_METRIC_NAME
    )
    expect(metric).toContain(SUCCESS_OUTCOME_LINE)
    expect(metric).toContain('outcome="conflict"} 1')
  })

  it('reports the current count of rotation-locked credential versions via a periodic gauge', async () => {
    const userId = await createTestUser('rotation-metrics')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await insertTestProject(orgId)
        const credentialId = await insertTestCredential(orgId, projectId)
        await withOrg(orgId, (tx) =>
          tx.insert(credentialVersions).values({
            orgId,
            credentialId,
            versionNumber: 1,
            rotationLockedAt: new Date(),
          })
        )

        const metric = await promRegister.getSingleMetricAsString(
          CREDENTIAL_VERSIONS_LOCKED_BY_ROTATION_METRIC_NAME
        )
        // Fixed, non-dynamic pattern (metric name is a compile-time constant import, but a
        // literal RegExp keeps the security/detect-non-literal-regexp rule happy).
        const match = metric.match(/^credential_versions_locked_by_rotation_total\s+(\d+)/m)
        expect(Number(match?.[1] ?? 0)).toBeGreaterThanOrEqual(1)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('increments the Story 5.2 checklist confirmations/retries counters labeled by outcome', async () => {
    rotationChecklistConfirmationsTotal.inc({ outcome: 'success' })
    rotationChecklistConfirmationsTotal.inc({ outcome: 'already_confirmed' })
    rotationChecklistRetriesTotal.inc({ outcome: 'success' })
    rotationChecklistRetriesTotal.inc({ outcome: 'max_exceeded' })

    const confirmMetric = await promRegister.getSingleMetricAsString(
      ROTATION_CHECKLIST_CONFIRMATIONS_TOTAL_METRIC_NAME
    )
    expect(confirmMetric).toContain(SUCCESS_OUTCOME_LINE)
    expect(confirmMetric).toContain('outcome="already_confirmed"} 1')

    const retryMetric = await promRegister.getSingleMetricAsString(
      ROTATION_CHECKLIST_RETRIES_TOTAL_METRIC_NAME
    )
    expect(retryMetric).toContain(SUCCESS_OUTCOME_LINE)
    expect(retryMetric).toContain('outcome="max_exceeded"} 1')
  })

  it('increments rotation_checklist_failures_total (no outcome label) on every fail call', async () => {
    rotationChecklistFailuresTotal.inc()
    rotationChecklistFailuresTotal.inc()
    const metric = await promRegister.getSingleMetricAsString(
      ROTATION_CHECKLIST_FAILURES_TOTAL_METRIC_NAME
    )
    const match = metric.match(/^rotation_checklist_failures_total\s+(\d+)/m)
    expect(Number(match?.[1] ?? 0)).toBe(2)
  })

  it('increments rotation_completions_total labeled by outcome', async () => {
    rotationCompletionsTotal.inc({ outcome: 'success' })
    rotationCompletionsTotal.inc({ outcome: 'checklist_incomplete' })
    const metric = await promRegister.getSingleMetricAsString(
      ROTATION_COMPLETIONS_TOTAL_METRIC_NAME
    )
    expect(metric).toContain(SUCCESS_OUTCOME_LINE)
    expect(metric).toContain('outcome="checklist_incomplete"} 1')
  })

  it('reports the current count of pending checklist items via a periodic gauge', async () => {
    const userId = await createTestUser('rotation-pending-metrics')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await insertTestProject(orgId)
        const credentialId = await insertTestCredential(orgId, projectId)
        const rotationId = await insertTestRotation(orgId, projectId, credentialId, 'in_progress')
        await withOrg(orgId, (tx) =>
          tx.insert(rotationChecklistItems).values({
            orgId,
            rotationId,
            systemName: 'pending-metrics-system',
            status: 'unconfirmed',
          })
        )

        const metric = await promRegister.getSingleMetricAsString(
          ROTATION_CHECKLIST_ITEMS_PENDING_TOTAL_METRIC_NAME
        )
        const match = metric.match(/^rotation_checklist_items_pending_total\s+(\d+)/m)
        expect(Number(match?.[1] ?? 0)).toBeGreaterThanOrEqual(1)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('increments rotation_break_glass_total labeled by outcome (Story 5.3 AC-24)', async () => {
    rotationBreakGlassTotal.inc({ outcome: 'success' })
    rotationBreakGlassTotal.inc({ outcome: 'conflict' })
    const metric = await promRegister.getSingleMetricAsString(
      ROTATION_BREAK_GLASS_TOTAL_METRIC_NAME
    )
    expect(metric).toContain(SUCCESS_OUTCOME_LINE)
    expect(metric).toContain('outcome="conflict"} 1')
  })

  it('increments rotation_stale_detections_total (no outcome label) once per stale transition (Story 5.3 AC-24)', async () => {
    rotationStaleDetectionsTotal.inc()
    rotationStaleDetectionsTotal.inc()
    const metric = await promRegister.getSingleMetricAsString(
      ROTATION_STALE_DETECTIONS_TOTAL_METRIC_NAME
    )
    const match = metric.match(/^rotation_stale_detections_total\s+(\d+)/m)
    expect(Number(match?.[1] ?? 0)).toBe(2)
  })

  it('increments rotation_resolutions_total labeled by outcome resumed/abandoned (Story 5.3 AC-24)', async () => {
    rotationResolutionsTotal.inc({ outcome: 'resumed' })
    rotationResolutionsTotal.inc({ outcome: 'abandoned' })
    const metric = await promRegister.getSingleMetricAsString(
      ROTATION_RESOLUTIONS_TOTAL_METRIC_NAME
    )
    expect(metric).toContain('outcome="resumed"} 1')
    expect(metric).toContain('outcome="abandoned"} 1')
  })

  it('increments rotation_break_glass_overlap_expirations_total (Story 5.3 AC-24/AC-8)', async () => {
    rotationBreakGlassOverlapExpirationsTotal.inc()
    const metric = await promRegister.getSingleMetricAsString(
      ROTATION_BREAK_GLASS_OVERLAP_EXPIRATIONS_TOTAL_METRIC_NAME
    )
    const match = metric.match(/^rotation_break_glass_overlap_expirations_total\s+(\d+)/m)
    expect(Number(match?.[1] ?? 0)).toBeGreaterThanOrEqual(1)
  })

  it('reports the current count of stale_recovery rotations via a periodic gauge (Story 5.3 AC-24)', async () => {
    const userId = await createTestUser('rotation-stale-pending-metrics')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await insertTestProject(orgId)
        const credentialId = await insertTestCredential(orgId, projectId)
        await insertTestRotation(orgId, projectId, credentialId, 'stale_recovery')

        const metric = await promRegister.getSingleMetricAsString(
          ROTATIONS_STALE_RECOVERY_PENDING_TOTAL_METRIC_NAME
        )
        const match = metric.match(/^rotations_stale_recovery_pending_total\s+(\d+)/m)
        expect(Number(match?.[1] ?? 0)).toBeGreaterThanOrEqual(1)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
