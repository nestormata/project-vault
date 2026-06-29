import { describe, expect, it } from 'vitest'
import { getDb, withOrg } from '../index.js'
import { pendingImports } from '../schema/index.js'
import { createTestUser, deleteTestUser, withTestOrg } from '../test-helpers.js'
import { createCredentialTestProject, withTwoTestOrgs } from './credential-test-helpers.js'
import {
  expectPendingImportInsertRejects,
  insertTestPendingImport,
} from './pending-import-test-helpers.js'

describe('pending_imports RLS cross-org isolation', () => {
  it('isolates pending_imports rows by org', async () => {
    const userId = await createTestUser('pending-imports')
    try {
      await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
        const projectAId = await createCredentialTestProject(orgAId, userId, 'proj-a')
        const projectBId = await createCredentialTestProject(orgBId, userId, 'proj-b')
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

        await withOrg(orgAId, (tx) =>
          insertTestPendingImport(tx, {
            orgId: orgAId,
            projectId: projectAId,
            createdBy: userId,
            expiresAt,
          })
        )
        await withOrg(orgBId, (tx) =>
          insertTestPendingImport(tx, {
            orgId: orgBId,
            projectId: projectBId,
            createdBy: userId,
            fileType: 'json',
            expiresAt,
          })
        )

        const orgARows = await withOrg(orgAId, (tx) => tx.select().from(pendingImports))
        expect(orgARows).toHaveLength(1)
        expect(orgARows[0]?.orgId).toBe(orgAId)

        const orgBRows = await withOrg(orgBId, (tx) => tx.select().from(pendingImports))
        expect(orgBRows).toHaveLength(1)
        expect(orgBRows[0]?.orgId).toBe(orgBId)

        const bareRows = await getDb().select().from(pendingImports)
        expect(bareRows).toHaveLength(0)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('rejects cross-org writes via RLS WITH CHECK default', async () => {
    const userId = await createTestUser('pending-imports-write')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withTestOrg(async ({ orgId: orgBId }) => {
          const projectAId = await createCredentialTestProject(orgAId, userId, 'proj-write-a')
          const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

          await expectPendingImportInsertRejects(() =>
            withOrg(orgAId, (tx) =>
              insertTestPendingImport(tx, {
                orgId: orgBId,
                projectId: projectAId,
                createdBy: userId,
                expiresAt,
              })
            )
          )
        })
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('rejects out-of-set file_type via CHECK constraint', async () => {
    const userId = await createTestUser('pending-imports-check')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-check')
        await expectPendingImportInsertRejects(() =>
          withOrg(orgId, (tx) =>
            tx.insert(pendingImports).values({
              orgId,
              projectId,
              createdBy: userId,
              fileType: 'csv' as 'env',
              itemCount: 0,
              items: [],
              warnings: [],
              expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            })
          )
        )
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('rejects item_count above 500 via CHECK constraint', async () => {
    const userId = await createTestUser('pending-imports-count')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-count')
        await expectPendingImportInsertRejects(() =>
          withOrg(orgId, (tx) =>
            insertTestPendingImport(tx, {
              orgId,
              projectId,
              createdBy: userId,
              itemCount: 501,
              expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            })
          )
        )
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('allows expiresAt before createdAt at DB layer', async () => {
    const userId = await createTestUser('pending-imports-expiry')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-expiry')
        await expect(
          withOrg(orgId, (tx) =>
            insertTestPendingImport(tx, {
              orgId,
              projectId,
              createdBy: userId,
              expiresAt: new Date(Date.now() - 60_000),
            }).then((id) => [{ id }])
          )
        ).resolves.toHaveLength(1)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
