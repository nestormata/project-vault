import { describe, expect, it, vi } from 'vitest'
import { withOrg } from '@project-vault/db'
import { withTestOrg } from '@project-vault/db/test-helpers'
import { configureRetention } from '../modules/audit/retention.js'
import { pruneExpiredAuditLogEntries } from './audit-retention-prune.js'

describe('Story 24.5a retention completion logging', () => {
  it('logs a completed organization purge even when it deletes zero rows', async () => {
    await withTestOrg(async ({ orgId }) => {
      await withOrg(orgId, (tx) => configureRetention(tx, orgId, 30))
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

      await pruneExpiredAuditLogEntries(logger)

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ orgId, deleted: 0 }),
        'Audit retention prune summary'
      )
    })
  })
})
