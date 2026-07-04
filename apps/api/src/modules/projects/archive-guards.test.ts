import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
import { insertTestProject } from '@project-vault/db/test-helpers'
import { credentials, credentialVersions, projects, rotations } from '@project-vault/db/schema'
import { eq } from 'drizzle-orm'
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

  /**
   * Inserts a credential with two versions and a rotation row at the given status, scoped to
   * `projectId`. Each call creates a fresh credential so multiple 'in_progress' rotations in the
   * same test don't collide with idx_rotations_one_in_progress_per_credential.
   */
  async function insertTestRotation(projectId: string, status: string): Promise<string> {
    return withOrg(orgId, async (tx) => {
      const [credential] = await tx
        .insert(credentials)
        .values({
          orgId,
          projectId,
          name: `rotation-guard-cred-${randomUUID()}`,
          createdBy: userId,
        })
        .returning({ id: credentials.id })
      if (!credential) throw new Error('expected credential to be inserted')

      const [previousVersion] = await tx
        .insert(credentialVersions)
        .values({ orgId, credentialId: credential.id, versionNumber: 1, createdBy: userId })
        .returning({ id: credentialVersions.id })
      const [newVersion] = await tx
        .insert(credentialVersions)
        .values({ orgId, credentialId: credential.id, versionNumber: 2, createdBy: userId })
        .returning({ id: credentialVersions.id })
      if (!previousVersion || !newVersion) {
        throw new Error('expected credential versions to be inserted')
      }

      const [rotation] = await tx
        .insert(rotations)
        .values({
          orgId,
          projectId,
          credentialId: credential.id,
          newVersionId: newVersion.id,
          previousVersionId: previousVersion.id,
          initiatedBy: userId,
          status,
        })
        .returning({ id: rotations.id })
      if (!rotation) throw new Error('expected rotation to be inserted')
      return rotation.id
    })
  }

  describe('findBlockingRotationIds', () => {
    it('returns [] for a project with no rotations', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'rotation-guard-none' })

      const blockingIds = await withOrg(orgId, (tx) => findBlockingRotationIds(tx, project.id))

      expect(blockingIds).toEqual([])
    })

    it('blocks on an in_progress rotation', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'rotation-guard-progress' })
      const rotationId = await insertTestRotation(project.id, 'in_progress')

      const blockingIds = await withOrg(orgId, (tx) => findBlockingRotationIds(tx, project.id))

      expect(blockingIds).toEqual([rotationId])
    })

    it('blocks on a stale_recovery rotation', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'rotation-guard-stale' })
      const rotationId = await insertTestRotation(project.id, 'stale_recovery')

      const blockingIds = await withOrg(orgId, (tx) => findBlockingRotationIds(tx, project.id))

      expect(blockingIds).toEqual([rotationId])
    })

    it('does not block on completed, abandoned, or break_glass_complete rotations', async () => {
      const project = await insertTestProject(orgId, {
        userId,
        slug: 'rotation-guard-nonblocking',
      })
      await insertTestRotation(project.id, 'completed')
      await insertTestRotation(project.id, 'abandoned')
      await insertTestRotation(project.id, 'break_glass_complete')

      const blockingIds = await withOrg(orgId, (tx) => findBlockingRotationIds(tx, project.id))

      expect(blockingIds).toEqual([])
    })

    it('only returns rotations belonging to the given project', async () => {
      const projectA = await insertTestProject(orgId, { userId, slug: 'rotation-guard-scope-a' })
      const projectB = await insertTestProject(orgId, { userId, slug: 'rotation-guard-scope-b' })
      await insertTestRotation(projectA.id, 'in_progress')

      const blockingIds = await withOrg(orgId, (tx) => findBlockingRotationIds(tx, projectB.id))

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
