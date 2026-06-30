import { describe, expect, it, vi } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'
import { createTestUser, deleteTestUser, withTestOrg } from '@project-vault/db/test-helpers'
import { runInboxPurge } from './notification-inbox-purge.js'
import {
  countInboxEntriesForTest,
  listInboxEntryIds,
  seedInboxEntryForTest,
} from './notification-inbox.js'
import { env } from '../config/env.js'

async function withPurgeTestUser(
  slug: string,
  fn: (ctx: {
    orgId: string
    userId: string
    logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
  }) => Promise<void>
): Promise<void> {
  const userId = await createTestUser(slug)
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as Pick<
    FastifyBaseLogger,
    'info' | 'warn' | 'error'
  >
  try {
    await withTestOrg(async ({ orgId }) => fn({ orgId, userId, logger }))
  } finally {
    await deleteTestUser(userId)
  }
}

describe('notification inbox purge', () => {
  it('deletes entries with expires_at in the past', async () => {
    await withPurgeTestUser('inbox-purge-expired', async ({ orgId, userId, logger }) => {
      await seedInboxEntryForTest(orgId, userId, {
        expiresAt: new Date(Date.now() - 1_000),
      })
      await seedInboxEntryForTest(orgId, userId, {
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })

      await runInboxPurge(logger)

      expect(await countInboxEntriesForTest(orgId, userId)).toBe(1)
    })
  })

  it('does not delete active (non-expired) entries', async () => {
    await withPurgeTestUser('inbox-purge-active', async ({ orgId, userId, logger }) => {
      await seedInboxEntryForTest(orgId, userId, {
        expiresAt: new Date(Date.now() + env.INBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000),
      })

      await runInboxPurge(logger)
      expect(await listInboxEntryIds(orgId, userId)).toHaveLength(1)
    })
  })
})
