import { describe, expect, it, vi, beforeEach } from 'vitest'

const getNotificationInboxMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/inbox.js', () => ({
  getNotificationInbox: getNotificationInboxMock,
  markInboxEntryRead: vi.fn(),
  markAllInboxRead: vi.fn(),
  dismissInboxEntry: vi.fn(),
}))

import { ApiClientError } from '$lib/api/client.js'
import { load } from './+page.server.js'

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

function makeEvent(searchParams: Record<string, string> = {}) {
  const url = new URL('http://localhost/notifications')
  for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, value)
  return { fetch: vi.fn(), url } as unknown as Parameters<typeof load>[0]
}

// Story 9.3 D8.4: GET /api/v1/notifications/inbox's response shape changed from a bare
// `{ data: [...], page, limit }` to `{ data: { items, total, page, limit, hasNext } }` — this
// asserts load() reads the new nested shape (inbox.data.items) rather than treating the whole
// `data` object as the notifications array (which would break +page.svelte's `.some()`/`.length`
// array usage the instant the API's actual response shape changed).
describe('/notifications +page.server.ts', () => {
  beforeEach(() => {
    getNotificationInboxMock.mockReset()
  })

  it('returns notifications as a real array read from inbox.data.items', async () => {
    getNotificationInboxMock.mockResolvedValue({
      data: { items: [SAMPLE_ENTRY], total: 1, page: 1, limit: 20, hasNext: false },
    })

    const result = await load(makeEvent())

    expect(Array.isArray(result.notifications)).toBe(true)
    expect(result.notifications).toEqual([SAMPLE_ENTRY])
    expect(result.page).toBe(1)
  })

  it('returns an empty notifications array when the inbox is empty', async () => {
    getNotificationInboxMock.mockResolvedValue({
      data: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
    })

    const result = await load(makeEvent())

    expect(result.notifications).toEqual([])
  })

  it('returns an empty array (not a thrown error) on a 403 from the API', async () => {
    getNotificationInboxMock.mockRejectedValue(new ApiClientError(403, null, 'forbidden'))

    const result = await load(makeEvent({ page: '2' }))

    expect(result.notifications).toEqual([])
    expect(result.page).toBe(2)
  })
})
