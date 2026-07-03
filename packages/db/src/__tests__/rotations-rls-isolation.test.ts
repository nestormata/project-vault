import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getDb, withOrg } from '../index.js'
import { credentialVersions, rotationChecklistItems, rotations } from '../schema/index.js'
import { createTestUser, deleteTestUser, withTestOrg } from '../test-helpers.js'
import { createCredentialTestProject, insertTestCredential } from './credential-test-helpers.js'

async function seedRotationFixture(orgId: string, projectId: string, userId: string) {
  const credentialId = await insertTestCredential(orgId, projectId, userId, 'Rotated Cred')
  const [previousVersion] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentialVersions)
      .values({ orgId, credentialId, versionNumber: 1, createdBy: userId })
      .returning({ id: credentialVersions.id })
  )
  const [newVersion] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentialVersions)
      .values({ orgId, credentialId, versionNumber: 2, createdBy: userId })
      .returning({ id: credentialVersions.id })
  )
  if (!previousVersion || !newVersion) throw new Error('expected test versions to be inserted')
  return { credentialId, previousVersionId: previousVersion.id, newVersionId: newVersion.id }
}

describe('rotations RLS cross-org isolation', () => {
  it('isolates rotations and rotation_checklist_items rows by org', async () => {
    const userId = await createTestUser('rotations')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withTestOrg(async ({ orgId: orgBId }) => {
          const projectAId = await createCredentialTestProject(orgAId, userId, 'proj-rot-a')
          const projectBId = await createCredentialTestProject(orgBId, userId, 'proj-rot-b')
          const fixtureA = await seedRotationFixture(orgAId, projectAId, userId)
          const fixtureB = await seedRotationFixture(orgBId, projectBId, userId)

          const [rotationA] = await withOrg(orgAId, (tx) =>
            tx
              .insert(rotations)
              .values({
                orgId: orgAId,
                projectId: projectAId,
                credentialId: fixtureA.credentialId,
                newVersionId: fixtureA.newVersionId,
                previousVersionId: fixtureA.previousVersionId,
                initiatedBy: userId,
              })
              .returning({ id: rotations.id })
          )
          const [rotationB] = await withOrg(orgBId, (tx) =>
            tx
              .insert(rotations)
              .values({
                orgId: orgBId,
                projectId: projectBId,
                credentialId: fixtureB.credentialId,
                newVersionId: fixtureB.newVersionId,
                previousVersionId: fixtureB.previousVersionId,
                initiatedBy: userId,
              })
              .returning({ id: rotations.id })
          )
          if (!rotationA || !rotationB) throw new Error('expected test rotations to be inserted')

          await withOrg(orgAId, (tx) =>
            tx.insert(rotationChecklistItems).values({
              orgId: orgAId,
              rotationId: rotationA.id,
              systemName: 'service-a',
            })
          )
          await withOrg(orgBId, (tx) =>
            tx.insert(rotationChecklistItems).values({
              orgId: orgBId,
              rotationId: rotationB.id,
              systemName: 'service-b',
            })
          )

          const orgARotations = await withOrg(orgAId, (tx) => tx.select().from(rotations))
          expect(orgARotations).toHaveLength(1)
          expect(orgARotations[0]?.orgId).toBe(orgAId)

          const orgBRotations = await withOrg(orgBId, (tx) => tx.select().from(rotations))
          expect(orgBRotations).toHaveLength(1)
          expect(orgBRotations[0]?.orgId).toBe(orgBId)

          const bareRotations = await getDb().select().from(rotations)
          expect(bareRotations).toHaveLength(0)

          const orgAItems = await withOrg(orgAId, (tx) => tx.select().from(rotationChecklistItems))
          expect(orgAItems).toHaveLength(1)
          expect(orgAItems[0]?.orgId).toBe(orgAId)

          const orgBItems = await withOrg(orgBId, (tx) => tx.select().from(rotationChecklistItems))
          expect(orgBItems).toHaveLength(1)
          expect(orgBItems[0]?.orgId).toBe(orgBId)

          const bareItems = await getDb().select().from(rotationChecklistItems)
          expect(bareItems).toHaveLength(0)

          // Attempted UPDATE/DELETE from org B's context against org A's rows affects zero rows
          // (WITH CHECK default backstop) — RLS filters them out of the USING clause entirely.
          const updateResult = await withOrg(orgBId, (tx) =>
            tx
              .update(rotations)
              .set({ notes: 'cross-org update attempt' })
              .where(eq(rotations.id, rotationA.id))
              .returning({ id: rotations.id })
          )
          expect(updateResult).toHaveLength(0)

          const deleteResult = await withOrg(orgBId, (tx) =>
            tx
              .delete(rotationChecklistItems)
              .where(eq(rotationChecklistItems.rotationId, rotationA.id))
              .returning({ id: rotationChecklistItems.id })
          )
          expect(deleteResult).toHaveLength(0)
        })
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('rejects cross-org writes via RLS WITH CHECK default', async () => {
    const userId = await createTestUser('rotations-write')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withTestOrg(async ({ orgId: orgBId }) => {
          const projectAId = await createCredentialTestProject(orgAId, userId, 'proj-rot-write-a')
          const fixtureA = await seedRotationFixture(orgAId, projectAId, userId)

          await expect(
            withOrg(orgAId, (tx) =>
              tx.insert(rotations).values({
                orgId: orgBId,
                projectId: projectAId,
                credentialId: fixtureA.credentialId,
                newVersionId: fixtureA.newVersionId,
                previousVersionId: fixtureA.previousVersionId,
                initiatedBy: userId,
              })
            )
          ).rejects.toThrow()
        })
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('rejects out-of-set status via CHECK constraint', async () => {
    const userId = await createTestUser('rotations-check')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-rot-check')
        const fixture = await seedRotationFixture(orgId, projectId, userId)

        await expect(
          withOrg(orgId, (tx) =>
            tx.insert(rotations).values({
              orgId,
              projectId,
              credentialId: fixture.credentialId,
              newVersionId: fixture.newVersionId,
              previousVersionId: fixture.previousVersionId,
              status: 'not_a_real_status',
              initiatedBy: userId,
            })
          )
        ).rejects.toThrow()
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('enforces at most one in_progress rotation per credential via the partial unique index', async () => {
    const userId = await createTestUser('rotations-unique')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-rot-unique')
        const fixture = await seedRotationFixture(orgId, projectId, userId)

        await withOrg(orgId, (tx) =>
          tx.insert(rotations).values({
            orgId,
            projectId,
            credentialId: fixture.credentialId,
            newVersionId: fixture.newVersionId,
            previousVersionId: fixture.previousVersionId,
            initiatedBy: userId,
          })
        )

        await expect(
          withOrg(orgId, (tx) =>
            tx.insert(rotations).values({
              orgId,
              projectId,
              credentialId: fixture.credentialId,
              newVersionId: fixture.newVersionId,
              previousVersionId: fixture.previousVersionId,
              initiatedBy: userId,
            })
          )
        ).rejects.toThrow()
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
