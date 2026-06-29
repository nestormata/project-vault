import { describe, expect, it } from 'vitest'
import { getDb, withOrg } from '../index.js'
import { credentialVersions, credentials, projects } from '../schema/index.js'
import { createTestUser, deleteTestUser, withTestOrg } from '../test-helpers.js'

async function createTestProject(orgId: string, userId: string, slug: string): Promise<string> {
  const [project] = await withOrg(orgId, (tx) =>
    tx
      .insert(projects)
      .values({ orgId, name: slug, slug, createdBy: userId })
      .returning({ id: projects.id })
  )
  if (!project) throw new Error('expected test project to be inserted')
  return project.id
}

describe('credentials RLS cross-org isolation', () => {
  it('isolates credentials and credential_versions rows by org', async () => {
    const userId = await createTestUser('credentials')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withTestOrg(async ({ orgId: orgBId }) => {
          const projectAId = await createTestProject(orgAId, userId, 'proj-a')
          const projectBId = await createTestProject(orgBId, userId, 'proj-b')

          const [credentialA] = await withOrg(orgAId, (tx) =>
            tx
              .insert(credentials)
              .values({
                orgId: orgAId,
                projectId: projectAId,
                name: 'Credential A',
                createdBy: userId,
              })
              .returning({ id: credentials.id })
          )
          const [credentialB] = await withOrg(orgBId, (tx) =>
            tx
              .insert(credentials)
              .values({
                orgId: orgBId,
                projectId: projectBId,
                name: 'Credential B',
                createdBy: userId,
              })
              .returning({ id: credentials.id })
          )
          if (!credentialA || !credentialB) {
            throw new Error('expected test credentials to be inserted')
          }

          await withOrg(orgAId, (tx) =>
            tx.insert(credentialVersions).values({
              orgId: orgAId,
              credentialId: credentialA.id,
              versionNumber: 1,
              createdBy: userId,
            })
          )
          await withOrg(orgBId, (tx) =>
            tx.insert(credentialVersions).values({
              orgId: orgBId,
              credentialId: credentialB.id,
              versionNumber: 1,
              createdBy: userId,
            })
          )

          const orgACreds = await withOrg(orgAId, (tx) => tx.select().from(credentials))
          expect(orgACreds).toHaveLength(1)
          expect(orgACreds[0]?.orgId).toBe(orgAId)

          const orgBCreds = await withOrg(orgBId, (tx) => tx.select().from(credentials))
          expect(orgBCreds).toHaveLength(1)
          expect(orgBCreds[0]?.orgId).toBe(orgBId)

          const bareCreds = await getDb().select().from(credentials)
          expect(bareCreds).toHaveLength(0)

          const orgAVersions = await withOrg(orgAId, (tx) => tx.select().from(credentialVersions))
          expect(orgAVersions).toHaveLength(1)
          expect(orgAVersions[0]?.orgId).toBe(orgAId)

          const orgBVersions = await withOrg(orgBId, (tx) => tx.select().from(credentialVersions))
          expect(orgBVersions).toHaveLength(1)
          expect(orgBVersions[0]?.orgId).toBe(orgBId)

          const bareVersions = await getDb().select().from(credentialVersions)
          expect(bareVersions).toHaveLength(0)
        })
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('enforces (credential_id, version_number) uniqueness', async () => {
    const userId = await createTestUser('version-unique')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await createTestProject(orgId, userId, 'proj-unique')
        const [credential] = await withOrg(orgId, (tx) =>
          tx
            .insert(credentials)
            .values({ orgId, projectId, name: 'Credential', createdBy: userId })
            .returning({ id: credentials.id })
        )
        if (!credential) throw new Error('expected test credential to be inserted')

        await withOrg(orgId, (tx) =>
          tx.insert(credentialVersions).values({
            orgId,
            credentialId: credential.id,
            versionNumber: 1,
            createdBy: userId,
          })
        )

        await expect(
          withOrg(orgId, (tx) =>
            tx.insert(credentialVersions).values({
              orgId,
              credentialId: credential.id,
              versionNumber: 1,
              createdBy: userId,
            })
          )
        ).rejects.toThrow()
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('rejects cross-org writes via RLS WITH CHECK default (credentials)', async () => {
    const userId = await createTestUser('write-isolation')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withTestOrg(async ({ orgId: orgBId }) => {
          const projectAId = await createTestProject(orgAId, userId, 'proj-write-a')

          await expect(
            withOrg(orgAId, (tx) =>
              tx.insert(credentials).values({
                orgId: orgBId,
                projectId: projectAId,
                name: 'Cross-org write',
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
})
