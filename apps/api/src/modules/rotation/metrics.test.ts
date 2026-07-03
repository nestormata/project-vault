import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { register as promRegister } from 'prom-client'
import { withOrg } from '@project-vault/db'
import { credentials, credentialVersions, projects } from '@project-vault/db/schema'
import { createTestUser, deleteTestUser, withTestOrg } from '@project-vault/db/test-helpers'
import {
  CREDENTIAL_VERSIONS_LOCKED_BY_ROTATION_METRIC_NAME,
  ROTATION_INITIATIONS_TOTAL_METRIC_NAME,
  rotationInitiationsTotal,
} from './metrics.js'

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

describe('rotation metrics', () => {
  afterEach(() => {
    rotationInitiationsTotal.reset()
  })

  it('increments rotation_initiations_total labeled by outcome', async () => {
    rotationInitiationsTotal.inc({ outcome: 'success' })
    rotationInitiationsTotal.inc({ outcome: 'conflict' })
    const metric = await promRegister.getSingleMetricAsString(
      ROTATION_INITIATIONS_TOTAL_METRIC_NAME
    )
    expect(metric).toContain('outcome="success"} 1')
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
})
