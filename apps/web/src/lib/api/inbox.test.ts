import { describe, expect, it, vi } from 'vitest'
import {
  dismissInboxEntry,
  getNotificationInbox,
  getUsersMe,
  markAllInboxRead,
  markInboxEntryRead,
} from './inbox.js'
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

  it.each([
    [jsonResponse({ message: 'nope' }, { status: 500 }), /failed to load/i],
    [new Response('', { status: 200 }), /failed to load/i],
  ])('rejects a non-success or empty response', async (response, expected) => {
    await expect(getNotificationInbox(vi.fn().mockResolvedValue(response))).rejects.toThrow(
      expected
    )
  })
})

describe('inbox mutations', () => {
  it('loads the current user through the shared client', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        userId: 'user-1',
        orgId: 'org-1',
        orgRole: 'admin',
        notifications: { unreadCount: 2 },
      })
    )
    expect((await getUsersMe(fetchFn)).notifications.unreadCount).toBe(2)
  })

  it.each([
    [markInboxEntryRead, ['notification-1']],
    [markAllInboxRead, []],
  ] as const)('accepts ordinary success and 204, but rejects failures', async (operation, args) => {
    await expect(
      operation(vi.fn().mockResolvedValue(new Response(null, { status: 200 })), ...args)
    ).resolves.toBeUndefined()
    await expect(
      operation(vi.fn().mockResolvedValue(new Response(null, { status: 204 })), ...args)
    ).resolves.toBeUndefined()
    await expect(
      operation(vi.fn().mockResolvedValue(new Response(null, { status: 500 })), ...args)
    ).rejects.toThrow(/failed/i)
  })

  it('maps dismiss success, 204, and failure to a boolean', async () => {
    await expect(
      dismissInboxEntry(
        vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
        'notification-1'
      )
    ).resolves.toBe(true)
    await expect(
      dismissInboxEntry(
        vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
        'notification-1'
      )
    ).resolves.toBe(true)
    await expect(
      dismissInboxEntry(
        vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
        'notification-1'
      )
    ).resolves.toBe(false)
  })
})
