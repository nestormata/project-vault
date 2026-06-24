import { describe, it, expect } from 'vitest'
import { getDb, withOrg, withOrgReadScope, withAdminAccess } from './index.js'
import { withTestOrg } from './test-helpers.js'

describe('getDb', () => {
  it('returns the same singleton instance across calls', () => {
    expect(getDb()).toBe(getDb())
  })
})

describe('withOrg', () => {
  it('rejects a non-UUID orgId before reaching the database', async () => {
    await expect(withOrg('not-a-uuid', async () => 'never')).rejects.toThrow(/invalid orgId/)
  })
})

describe('withOrgReadScope', () => {
  it('delegates to withOrg and exposes the same org-scoped tx', async () => {
    await withTestOrg(async ({ orgId }) => {
      const result = await withOrgReadScope(orgId, async () => 'read-ok')
      expect(result).toBe('read-ok')
    })
  })
})

describe('withAdminAccess', () => {
  it('throws when authCtx.role is not admin', async () => {
    await expect(withAdminAccess({ role: 'member' }, async () => 'never')).rejects.toThrow(
      /not an admin/
    )
  })

  it('runs fn when authCtx.role is admin', async () => {
    const result = await withAdminAccess({ role: 'admin' }, async () => 'admin-ok')
    expect(result).toBe('admin-ok')
  })
})
