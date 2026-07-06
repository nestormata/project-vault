import { describe, it, expect } from 'vitest'
import { withOrg } from '@project-vault/db'
import { withTestOrg } from '@project-vault/db/test-helpers'
import { configureRetention, getRetentionConfig } from './retention.js'

describe('configureRetention (AC-22)', () => {
  it('upserts retentionDays for the org', async () => {
    await withTestOrg(async ({ orgId }) => {
      const result = await withOrg(orgId, (tx) => configureRetention(tx, orgId, 365))
      expect(result.retentionDays).toBe(365)

      const stored = await withOrg(orgId, (tx) => getRetentionConfig(tx, orgId))
      expect(stored?.retentionDays).toBe(365)
    })
  })

  it('accepts null as an explicit "retain forever" state', async () => {
    await withTestOrg(async ({ orgId }) => {
      const result = await withOrg(orgId, (tx) => configureRetention(tx, orgId, null))
      expect(result.retentionDays).toBeNull()
    })
  })

  it('re-configuring updates the existing row rather than inserting a duplicate', async () => {
    await withTestOrg(async ({ orgId }) => {
      await withOrg(orgId, (tx) => configureRetention(tx, orgId, 90))
      await withOrg(orgId, (tx) => configureRetention(tx, orgId, 180))
      const stored = await withOrg(orgId, (tx) => getRetentionConfig(tx, orgId))
      expect(stored?.retentionDays).toBe(180)
    })
  })
})
