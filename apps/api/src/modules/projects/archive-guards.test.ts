import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { insertTestProject } from '@project-vault/db/test-helpers'
import { credentials, credentialVersions, projects, rotations } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootProjectRouteTestApp } from './project-route-test-bootstrap.js'
import {
  findBlockingRotationIds,
  hasActiveMachineUserKeys,
  isProjectArchived,
} from './archive-guards.js'

/** Seeds a credential + two versions + a rotation row so findBlockingRotationIds has a real row. */
async function seedRotation(
  orgId: string,
  projectId: string,
  userId: string,
  status?: string
): Promise<string> {
  const [credential] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentials)
      .values({ orgId, projectId, name: `cred-${randomUUID()}`, createdBy: userId })
      .returning({ id: credentials.id })
  )
  if (!credential) throw new Error('expected test credential to be inserted')

  const [previousVersion] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentialVersions)
      .values({ orgId, credentialId: credential.id, versionNumber: 1, createdBy: userId })
      .returning({ id: credentialVersions.id })
  )
  const [newVersion] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentialVersions)
      .values({ orgId, credentialId: credential.id, versionNumber: 2, createdBy: userId })
      .returning({ id: credentialVersions.id })
  )
  if (!previousVersion || !newVersion) throw new Error('expected test versions to be inserted')

  const [rotation] = await withOrg(orgId, (tx) =>
    tx
      .insert(rotations)
      .values({
        orgId,
        projectId,
        credentialId: credential.id,
        newVersionId: newVersion.id,
        previousVersionId: previousVersion.id,
        initiatedBy: userId,
        ...(status !== undefined ? { status } : {}),
      })
      .returning({ id: rotations.id })
  )
  if (!rotation) throw new Error('expected test rotation to be inserted')
  return rotation.id
}

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

describe('archive-guards', () => {
  let app: TestApp
  let orgId: string
  let userId: string

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
    const user = await registerAndLoginViaApi(app, {
      email: `archive-guards-${randomUUID()}@example.com`,
      password: 'correct-horse-battery-staple',
      orgName: `Archive Guards ${randomUUID()}`,
    })
    orgId = user.orgId
    userId = user.userId
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  describe('findBlockingRotationIds', () => {
    it('returns [] for a project with no rotations', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'rotation-guard-none' })

      const blockingIds = await withOrg(orgId, (tx) => findBlockingRotationIds(tx, project.id))

      expect(blockingIds).toEqual([])
    })

    it('returns the id of an in_progress rotation', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'rotation-guard-progress' })
      const rotationId = await seedRotation(orgId, project.id, userId)

      const blockingIds = await withOrg(orgId, (tx) => findBlockingRotationIds(tx, project.id))

      expect(blockingIds).toEqual([rotationId])
    })

    it('returns the id of a stale_recovery rotation', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'rotation-guard-stale' })
      const rotationId = await seedRotation(orgId, project.id, userId, 'stale_recovery')

      const blockingIds = await withOrg(orgId, (tx) => findBlockingRotationIds(tx, project.id))

      expect(blockingIds).toEqual([rotationId])
    })

    it('does not block on a completed rotation', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'rotation-guard-completed' })
      await seedRotation(orgId, project.id, userId, 'completed')

      const blockingIds = await withOrg(orgId, (tx) => findBlockingRotationIds(tx, project.id))

      expect(blockingIds).toEqual([])
    })
  })

  describe('hasActiveMachineUserKeys (Epic 7 stub)', () => {
    it('always returns false until Epic 7 ships', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'machine-user-guard' })
      const result = await withOrg(orgId, (tx) => hasActiveMachineUserKeys(tx, project.id))
      expect(result).toBe(false)
    })
  })

  describe('isProjectArchived', () => {
    it('returns false for an active project and true once archived_at is set', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'archived-guard' })

      const beforeArchive = await withOrg(orgId, (tx) => isProjectArchived(tx, project.id))
      expect(beforeArchive).toBe(false)

      await withOrg(orgId, (tx) =>
        tx.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, project.id))
      )

      const afterArchive = await withOrg(orgId, (tx) => isProjectArchived(tx, project.id))
      expect(afterArchive).toBe(true)
    })

    it('returns false for a non-existent project id', async () => {
      const result = await withOrg(orgId, (tx) => isProjectArchived(tx, randomUUID()))
      expect(result).toBe(false)
    })
  })
})
