import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getDb, withOrg } from '../index.js'
import { credentialDependencies } from '../schema/index.js'
import { createTestUser, deleteTestUser, withTestOrg } from '../test-helpers.js'
import { createCredentialTestProject, insertTestCredential } from './credential-test-helpers.js'
describe('credential_dependencies RLS cross-org isolation', () => {
  it('isolates credential_dependencies rows by org', async () => {
    const userId = await createTestUser('credential-deps')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withTestOrg(async ({ orgId: orgBId }) => {
          const projectAId = await createCredentialTestProject(orgAId, userId, 'proj-a')
          const projectBId = await createCredentialTestProject(orgBId, userId, 'proj-b')

          const credentialAId = await insertTestCredential(orgAId, projectAId, userId, 'Cred A')
          const credentialBId = await insertTestCredential(orgBId, projectBId, userId, 'Cred B')

          await withOrg(orgAId, (tx) =>
            tx.insert(credentialDependencies).values({
              orgId: orgAId,
              credentialId: credentialAId,
              systemName: 'service-a',
              createdBy: userId,
            })
          )
          await withOrg(orgBId, (tx) =>
            tx.insert(credentialDependencies).values({
              orgId: orgBId,
              credentialId: credentialBId,
              systemName: 'service-b',
              createdBy: userId,
            })
          )

          const orgADeps = await withOrg(orgAId, (tx) => tx.select().from(credentialDependencies))
          expect(orgADeps).toHaveLength(1)
          expect(orgADeps[0]?.orgId).toBe(orgAId)

          const orgBDeps = await withOrg(orgBId, (tx) => tx.select().from(credentialDependencies))
          expect(orgBDeps).toHaveLength(1)
          expect(orgBDeps[0]?.orgId).toBe(orgBId)

          const bareDeps = await getDb().select().from(credentialDependencies)
          expect(bareDeps).toHaveLength(0)
        })
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('rejects cross-org writes via RLS WITH CHECK default', async () => {
    const userId = await createTestUser('credential-deps-write')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withTestOrg(async ({ orgId: orgBId }) => {
          const projectAId = await createCredentialTestProject(orgAId, userId, 'proj-write-a')
          const credentialAId = await insertTestCredential(orgAId, projectAId, userId, 'Cred')

          await expect(
            withOrg(orgAId, (tx) =>
              tx.insert(credentialDependencies).values({
                orgId: orgBId,
                credentialId: credentialAId,
                systemName: 'cross-org',
                createdBy: userId,
              })
            )
          ).rejects.toThrow()
        })
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('rejects out-of-set system_type via CHECK constraint', async () => {
    const userId = await createTestUser('credential-deps-check')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-check')
        const credentialId = await insertTestCredential(orgId, projectId, userId, 'Cred')

        await expect(
          withOrg(orgId, (tx) =>
            tx.insert(credentialDependencies).values({
              orgId,
              credentialId,
              systemName: 'bad-type',
              systemType: 'frobnicator',
              createdBy: userId,
            })
          )
        ).rejects.toThrow()
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('preserves archived rows without deleting them', async () => {
    const userId = await createTestUser('credential-deps-archive')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-archive')
        const credentialId = await insertTestCredential(orgId, projectId, userId, 'Cred')

        const [dependency] = await withOrg(orgId, (tx) =>
          tx
            .insert(credentialDependencies)
            .values({
              orgId,
              credentialId,
              systemName: 'archived-service',
              createdBy: userId,
            })
            .returning()
        )
        if (!dependency) throw new Error('expected dependency')
        expect(dependency.archivedAt).toBeNull()

        await withOrg(orgId, (tx) =>
          tx
            .update(credentialDependencies)
            .set({ archivedAt: new Date(), archivedBy: userId })
            .where(eq(credentialDependencies.id, dependency.id))
        )

        const rows = await withOrg(orgId, (tx) =>
          tx
            .select()
            .from(credentialDependencies)
            .where(eq(credentialDependencies.id, dependency.id))
        )
        expect(rows).toHaveLength(1)
        expect(rows[0]?.archivedAt).not.toBeNull()
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
