import { describe, it, expect } from 'vitest'
import { withTestOrg } from './test-helpers.js'

describe('withTestOrg stub', () => {
  it('calls fn with a valid orgId', async () => {
    const result = await withTestOrg(async ({ orgId }) => {
      expect(orgId).toMatch(/^[0-9a-f-]{36}$/)
      return orgId
    })
    expect(result).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('returns the fn result', async () => {
    const result = await withTestOrg(async () => 42)
    expect(result).toBe(42)
  })
})
