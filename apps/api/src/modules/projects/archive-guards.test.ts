import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
import { insertTestProject } from '@project-vault/db/test-helpers'
import {
  apiKeys,
  credentials,
  credentialShares,
  credentialVersions,
  machineUsers,
  projects,
  rotations,
} from '@project-vault/db/schema'
import { eq } from 'drizzle-orm'
import {
  bootstrapRouteIntegrationTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootProjectRouteTestApp } from './project-route-test-bootstrap.js'
import {
  findBlockingRotationIds,
  findBlockingShareIds,
  hasActiveMachineUserKeys,
  isProjectArchived,
} from './archive-guards.js'

const MACHINE_USER_INSERT_FAILED = 'machine user insert returned no row'

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

    it.each([
      {
        status: 'in_progress' as const,
        slug: 'rotation-guard-progress',
        label: 'an in_progress rotation',
      },
      {
        status: 'stale_recovery' as const,
        slug: 'rotation-guard-stale',
        label: 'a stale_recovery rotation',
      },
      {
        status: 'staged' as const,
        slug: 'rotation-guard-staged',
        label: '(Story 5.6 AC-10.1) a staged rotation',
      },
      {
        status: 'promoted' as const,
        slug: 'rotation-guard-promoted',
        label: '(Story 5.6 AC-10.1) a promoted (unretired) rotation',
      },
    ])('blocks on $label', async ({ status, slug }) => {
      const project = await insertTestProject(orgId, { userId, slug })
      const rotationId = await insertTestRotation(project.id, status)

      const blockingIds = await withOrg(orgId, (tx) => findBlockingRotationIds(tx, project.id))

      expect(blockingIds).toEqual([rotationId])
    })

    it('(Story 5.6 AC-10.1) does not block on a retired rotation', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'rotation-guard-retired' })
      await insertTestRotation(project.id, 'retired')

      const blockingIds = await withOrg(orgId, (tx) => findBlockingRotationIds(tx, project.id))

      expect(blockingIds).toEqual([])
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

  /** Story 17.1 AC-19: inserts a credential + credential_shares row scoped to `projectId`. */
  async function insertTestShare(projectId: string, status: string): Promise<string> {
    return withOrg(orgId, async (tx) => {
      const [credential] = await tx
        .insert(credentials)
        .values({
          orgId,
          projectId,
          name: `share-guard-cred-${randomUUID()}`,
          createdBy: userId,
        })
        .returning({ id: credentials.id })
      if (!credential) throw new Error('expected credential to be inserted')

      const [share] = await tx
        .insert(credentialShares)
        .values({
          orgId,
          credentialId: credential.id,
          sharedBy: userId,
          recipientType: 'user',
          recipientUserId: userId,
          tokenHash: `test-hash-${randomUUID()}`,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          status,
        })
        .returning({ id: credentialShares.id })
      if (!share) throw new Error('expected credential share to be inserted')
      return share.id
    })
  }

  /** Story 17.2 AC-20: same as insertTestShare above, but recipient_type = 'external' — closes
   *  17.1's test-coverage gap (it only ever exercised member shares against this guard). */
  async function insertTestExternalShare(projectId: string, status: string): Promise<string> {
    return withOrg(orgId, async (tx) => {
      const [credential] = await tx
        .insert(credentials)
        .values({
          orgId,
          projectId,
          name: `share-guard-external-cred-${randomUUID()}`,
          createdBy: userId,
        })
        .returning({ id: credentials.id })
      if (!credential) throw new Error('expected external-share-guard credential to be inserted')

      const [share] = await tx
        .insert(credentialShares)
        .values({
          orgId,
          credentialId: credential.id,
          sharedBy: userId,
          recipientType: 'external',
          recipientEmail: 'priya@vendor.example',
          tokenHash: `test-hash-${randomUUID()}`,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          status,
        })
        .returning({ id: credentialShares.id })
      if (!share) throw new Error('expected external credential share to be inserted')
      return share.id
    })
  }

  describe('findBlockingShareIds (Story 17.1 AC-19)', () => {
    it('returns [] for a project with no shares', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'share-guard-none' })

      const blockingIds = await withOrg(orgId, (tx) => findBlockingShareIds(tx, project.id))

      expect(blockingIds).toEqual([])
    })

    it('blocks on an active share', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'share-guard-active' })
      const shareId = await insertTestShare(project.id, 'active')

      const blockingIds = await withOrg(orgId, (tx) => findBlockingShareIds(tx, project.id))

      expect(blockingIds).toEqual([shareId])
    })

    it('does not block on revoked, expired, viewed, or superseded shares', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'share-guard-terminal' })
      await insertTestShare(project.id, 'revoked')
      await insertTestShare(project.id, 'expired')
      await insertTestShare(project.id, 'viewed')
      await insertTestShare(project.id, 'superseded')

      const blockingIds = await withOrg(orgId, (tx) => findBlockingShareIds(tx, project.id))

      expect(blockingIds).toEqual([])
    })

    // Story 17.2 AC-20: 17.1 only ever tested this guard against member (recipient_type='user')
    // shares — this closes that gap by confirming the same generalized-by-status query (already
    // filters only on status/credentialId, never recipient_type) blocks on an external share too.
    it('(Story 17.2 AC-20) blocks on an active external share', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'share-guard-external' })
      const shareId = await insertTestExternalShare(project.id, 'active')

      const blockingIds = await withOrg(orgId, (tx) => findBlockingShareIds(tx, project.id))

      expect(blockingIds).toEqual([shareId])
    })

    it('only returns shares belonging to the given project', async () => {
      const projectA = await insertTestProject(orgId, { userId, slug: 'share-guard-scope-a' })
      const projectB = await insertTestProject(orgId, { userId, slug: 'share-guard-scope-b' })
      await insertTestShare(projectA.id, 'active')

      const blockingIds = await withOrg(orgId, (tx) => findBlockingShareIds(tx, projectB.id))

      expect(blockingIds).toEqual([])
    })
  })

  describe('hasActiveMachineUserKeys (Story 7.2 D12 — closed stub)', () => {
    it('returns false when the project has no machine users at all', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'machine-user-guard-none' })
      const result = await withOrg(orgId, (tx) => hasActiveMachineUserKeys(tx, project.id))
      expect(result).toBe(false)
    })

    it('returns true when the project has a non-revoked, non-expired machine-user key', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'machine-user-guard-active' })
      await withOrg(orgId, async (tx) => {
        const [mu] = await tx
          .insert(machineUsers)
          .values({ orgId, projectId: project.id, name: 'bot', role: 'member', createdBy: userId })
          .returning()
        if (!mu) throw new Error(MACHINE_USER_INSERT_FAILED)
        await tx.insert(apiKeys).values({
          orgId,
          machineUserId: mu.id,
          name: 'key',
          keyHash: randomUUID(),
        })
      })

      const result = await withOrg(orgId, (tx) => hasActiveMachineUserKeys(tx, project.id))
      expect(result).toBe(true)
    })

    it('returns false when the only key is revoked', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'machine-user-guard-revoked' })
      await withOrg(orgId, async (tx) => {
        const [mu] = await tx
          .insert(machineUsers)
          .values({ orgId, projectId: project.id, name: 'bot', role: 'member', createdBy: userId })
          .returning()
        if (!mu) throw new Error(MACHINE_USER_INSERT_FAILED)
        await tx.insert(apiKeys).values({
          orgId,
          machineUserId: mu.id,
          name: 'key',
          keyHash: randomUUID(),
          revokedAt: new Date(),
        })
      })

      const result = await withOrg(orgId, (tx) => hasActiveMachineUserKeys(tx, project.id))
      expect(result).toBe(false)
    })

    it('returns false when the only key has naturally expired (expiresAt in the past, revokedAt null)', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'machine-user-guard-expired' })
      await withOrg(orgId, async (tx) => {
        const [mu] = await tx
          .insert(machineUsers)
          .values({ orgId, projectId: project.id, name: 'bot', role: 'member', createdBy: userId })
          .returning()
        if (!mu) throw new Error(MACHINE_USER_INSERT_FAILED)
        await tx.insert(apiKeys).values({
          orgId,
          machineUserId: mu.id,
          name: 'key',
          keyHash: randomUUID(),
          expiresAt: new Date(Date.now() - 1000),
        })
      })

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
