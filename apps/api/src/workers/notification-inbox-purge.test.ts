import { describe, expect, it, vi } from 'vitest'
import { createTestUser, deleteTestUser, withTestOrg } from '@project-vault/db/test-helpers'
import { runInboxPurge } from './notification-inbox-purge.js'
import {
  countInboxEntriesForTest,
  listInboxEntryIds,
  seedInboxEntryForTest,
} from './notification-inbox.js'
import { env } from '../config/env.js'

describe('notification inbox purge', () => {
  it('deletes entries with expires_at in the past', async () => {
    const userId = await createTestUser('inbox-purge-expired')
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    try {
      await withTestOrg(async ({ orgId }) => {
        await seedInboxEntryForTest(orgId, userId, {
          expiresAt: new Date(Date.now() - 1_000),
        })
        await seedInboxEntryForTest(orgId, userId, {
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        })

        await runInboxPurge(logger)

        expect(await countInboxEntriesForTest(orgId, userId)).toBe(1)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('does not delete active (non-expired) entries', async () => {
    const userId = await createTestUser('inbox-purge-active')
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    try {
      await withTestOrg(async ({ orgId }) => {
        await seedInboxEntryForTest(orgId, userId, {
          expiresAt: new Date(Date.now() + env.INBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000),
        })

        await runInboxPurge(logger)
        expect(await listInboxEntryIds(orgId, userId)).toHaveLength(1)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
