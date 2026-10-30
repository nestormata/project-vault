import { describe, expect, it, vi } from 'vitest'
import { getDashboardAttention } from './dashboard.js'
import { jsonResponse } from '$lib/test/json-response.js'

describe('dashboard API wrapper (Story 72-12)', () => {
  it('getDashboardAttention unwraps the list from GET /dashboard/attention', async () => {
    const attention = {
      items: [],
      counts: { expiringShares: 0, expiringCertificates: 0, pendingInvitations: 0 },
    }
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: attention }))
    const result = await getDashboardAttention(fetchFn)
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/dashboard/attention',
      expect.objectContaining({ credentials: 'include' })
    )
    expect(result).toEqual(attention)
  })
})
