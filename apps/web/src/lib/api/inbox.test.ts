import { describe, expect, it, vi } from 'vitest'
import { getNotificationInbox } from './inbox.js'
import { jsonResponse } from '$lib/test/json-response.js'

const SAMPLE_ENTRY = {
  id: '00000000-0000-4000-8000-000000000001',
  alertType: 'credential.expiring',
  severity: 'warning',
  title: 'Credential expiring soon',
  body: 'Stripe API Key expires in 3 days',
  projectId: null,
  resourceId: null,
  resourceType: null,
  readAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
}

// Story 9.3 D8.4: GET /api/v1/notifications/inbox's response shape changed from a bare
// `{ data: [...], page, limit }` to `{ data: { items, total, page, limit, hasNext } }` — this
// is the real, confirmed consumer of the old shape, updated in the same PR as the API fix.
describe('getNotificationInbox', () => {
  it('returns the nested { items, total, page, limit, hasNext } envelope', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { items: [SAMPLE_ENTRY], total: 1, page: 1, limit: 20, hasNext: false },
      })
    )

    const result = await getNotificationInbox(fetchFn)

    expect(result.data.items).toEqual([SAMPLE_ENTRY])
    expect(result.data.total).toBe(1)
    expect(result.data.page).toBe(1)
    expect(result.data.limit).toBe(20)
    expect(result.data.hasNext).toBe(false)
  })

  it('forwards page/limit/status query params', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { items: [], total: 0, page: 2, limit: 5, hasNext: false },
      })
    )

    await getNotificationInbox(fetchFn, { page: 2, limit: 5, status: 'unread' })

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/notifications/inbox?page=2&limit=5&status=unread',
      expect.objectContaining({ credentials: 'include' })
    )
  })
})
