import { describe, expect, it } from 'vitest'
import { inArray } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { pendingImports } from '@project-vault/db/schema'
import {
  createTestUser,
  deleteTestUser,
  insertTestProject,
  withTestOrg,
} from '@project-vault/db/test-helpers'
import { importCleanupExpired } from './import-cleanup.js'

async function insertCleanupFixtureRow(
  orgId: string,
  projectId: string,
  userId: string,
  expiresAt: Date
): Promise<string> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(pendingImports)
      .values({
        orgId,
        projectId,
        createdBy: userId,
        fileType: 'env',
        itemCount: 0,
        items: [],
        warnings: [],
        expiresAt,
      })
      .returning({ id: pendingImports.id })
  )
  if (!row?.id) throw new Error('expected pending import fixture row')
  return row.id
}

describe('import:cleanup-expired worker', () => {
  it('deletes expired rows and preserves active rows', async () => {
    const userId = await createTestUser('import-cleanup')
    try {
      await withTestOrg(async ({ orgId }) => {
        const project = await insertTestProject(orgId, { userId, slug: 'cleanup-proj' })
        const expiredId = await insertCleanupFixtureRow(orgId, project.id, userId, new Date(0))
        const activeId = await insertCleanupFixtureRow(
          orgId,
          project.id,
          userId,
          new Date(Date.now() + 15 * 60 * 1000)
        )

        await importCleanupExpired()

        const remaining = await withOrg(orgId, (tx) =>
          tx
            .select({ id: pendingImports.id })
            .from(pendingImports)
            .where(inArray(pendingImports.id, [expiredId, activeId]))
        )
        expect(remaining.map((row) => row.id)).toEqual([activeId])
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('is idempotent when run twice', async () => {
    const userId = await createTestUser('import-cleanup-idempotent')
    try {
      await withTestOrg(async ({ orgId }) => {
        const project = await insertTestProject(orgId, { userId, slug: 'cleanup-idem' })
        const expiredId = await insertCleanupFixtureRow(
          orgId,
          project.id,
          userId,
          new Date(Date.now() - 60_000)
        )

        await importCleanupExpired()
        // Second run must not throw on an already-deleted row and must leave it deleted.
        await expect(importCleanupExpired()).resolves.toBeUndefined()

        const remaining = await withOrg(orgId, (tx) =>
          tx
            .select({ id: pendingImports.id })
            .from(pendingImports)
            .where(inArray(pendingImports.id, [expiredId]))
        )
        expect(remaining).toEqual([])
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
