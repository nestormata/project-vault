import { describe, it, expect } from 'vitest'
import { withOrg } from '../index.js'
import { credentialVersions, rotations, credentialDependencies } from '../schema/index.js'
import { createTestUser, deleteTestUser, withTestOrg } from '../test-helpers.js'
import { createCredentialTestProject, insertTestCredential } from './credential-test-helpers.js'

/**
 * Story 13.4 Task 1: migration 0055 is purely additive (two new nullable columns, no backfill).
 * This test confirms the migration actually applied against the real test DB — the columns are
 * readable/writable via the drizzle schema, and rows that omit them still default to NULL, which
 * is the correct semantic for every pre-existing row (no backfill needed, unlike migration 0050).
 */
describe('migration 0055 — rotations.target_fields / credential_dependencies.field_key', () => {
  it('writes and reads rotations.target_fields, defaults to NULL when omitted', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('migration-0055-rotations')
      try {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-0055')
        const credentialId = await insertTestCredential(orgId, projectId, userId, 'cred-0055')
        const credentialId2 = await insertTestCredential(orgId, projectId, userId, 'cred-0055-b')

        async function insertVersionPair(credId: string) {
          const [prevVersion] = await withOrg(orgId, (tx) =>
            tx
              .insert(credentialVersions)
              .values({
                orgId,
                credentialId: credId,
                versionNumber: 1,
                promotedAt: new Date(),
                encryptedValue: { version: 1, iv: 'iv', ciphertext: 'ct-1', tag: 'tag' },
              })
              .returning({ id: credentialVersions.id })
          )
          const [newVersion] = await withOrg(orgId, (tx) =>
            tx
              .insert(credentialVersions)
              .values({
                orgId,
                credentialId: credId,
                versionNumber: 2,
                encryptedValue: { version: 1, iv: 'iv', ciphertext: 'ct-2', tag: 'tag' },
              })
              .returning({ id: credentialVersions.id })
          )
          if (!prevVersion || !newVersion) throw new Error('expected versions to be inserted')
          return { prevVersion, newVersion }
        }

        const pair1 = await insertVersionPair(credentialId)
        const pair2 = await insertVersionPair(credentialId2)

        const [withTargets] = await withOrg(orgId, (tx) =>
          tx
            .insert(rotations)
            .values({
              orgId,
              projectId,
              credentialId,
              newVersionId: pair1.newVersion.id,
              previousVersionId: pair1.prevVersion.id,
              status: 'staged',
              initiatedBy: userId,
              targetFields: ['password'],
            })
            .returning({ id: rotations.id, targetFields: rotations.targetFields })
        )
        expect(withTargets?.targetFields).toEqual(['password'])

        const [whole] = await withOrg(orgId, (tx) =>
          tx
            .insert(rotations)
            .values({
              orgId,
              projectId,
              credentialId: credentialId2,
              newVersionId: pair2.newVersion.id,
              previousVersionId: pair2.prevVersion.id,
              status: 'staged',
              initiatedBy: userId,
            })
            .returning({ id: rotations.id, targetFields: rotations.targetFields })
        )
        expect(whole?.targetFields).toBeNull()
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('writes and reads credential_dependencies.field_key, defaults to NULL when omitted', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('migration-0055-deps')
      try {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-0055-dep')
        const credentialId = await insertTestCredential(orgId, projectId, userId, 'cred-0055-dep')

        const [scoped] = await withOrg(orgId, (tx) =>
          tx
            .insert(credentialDependencies)
            .values({
              orgId,
              credentialId,
              systemName: 'CI Pipeline',
              createdBy: userId,
              fieldKey: 'password',
            })
            .returning({ id: credentialDependencies.id, fieldKey: credentialDependencies.fieldKey })
        )
        expect(scoped?.fieldKey).toBe('password')

        const [wholeCredential] = await withOrg(orgId, (tx) =>
          tx
            .insert(credentialDependencies)
            .values({
              orgId,
              credentialId,
              systemName: 'Backup Script',
              createdBy: userId,
            })
            .returning({ id: credentialDependencies.id, fieldKey: credentialDependencies.fieldKey })
        )
        expect(wholeCredential?.fieldKey).toBeNull()
      } finally {
        await deleteTestUser(userId)
      }
    })
  })
})
