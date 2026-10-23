import { isRedirect } from '@sveltejs/kit'
import { apiFetch, apiFetchBody } from './client.js'

export type UserMeResponse = {
  userId: string
  orgId: string
  orgRole: 'owner' | 'admin' | 'member' | 'viewer'
  // Story 15.1 AC 7 — the user's persisted display-language preference, source of truth for
  // restoring the selection across sessions/devices.
  locale: 'en' | 'es'
  notifications: { unreadCount: number }
}

export type InboxEntry = {
  id: string
  alertType: string
  severity: string
  title: string
  body: string
  projectId: string | null
  resourceId: string | null
  resourceType: string | null
  readAt: string | null
  createdAt: string
}

// Story 9.3 D8.4: restructured from a bare `{ data: [...], page, limit }` shape (missing
// total/hasNext entirely) to `{ data: { items, total, page, limit, hasNext } }`, matching every
// other collection endpoint's API contract. Confirmed breaking response-shape change — this type
// and notifications/+page.server.ts's load() are updated in the same PR as the API fix.
export type InboxListResponse = {
  data: {
    items: InboxEntry[]
    total: number
    page: number
    limit: number
    hasNext: boolean
  }
}

export function getUsersMe(fetchFn: typeof fetch) {
  return apiFetch<UserMeResponse>(fetchFn, '/api/v1/users/me')
}

export async function getNotificationInbox(
  fetchFn: typeof fetch,
  query: { page?: number; limit?: number; status?: 'all' | 'unread' | 'read' } = {}
): Promise<InboxListResponse> {
  const params = new URLSearchParams()
  if (query.page) params.set('page', String(query.page))
  if (query.limit) params.set('limit', String(query.limit))
  if (query.status) params.set('status', query.status)
  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  // `{ data: { items, ... } }` is the contract callers read (`inbox.data.items`), so keep the whole
  // body rather than apiFetch's `data` unwrap.
  const body = await apiFetchBody<InboxListResponse | null>(
    fetchFn,
    `/api/v1/notifications/inbox${suffix}`
  )
  if (!body) throw new Error('Failed to load notification inbox')
  return body
}

export async function markInboxEntryRead(fetchFn: typeof fetch, id: string): Promise<void> {
  await apiFetch<undefined>(fetchFn, `/api/v1/notifications/inbox/${id}/read`, { method: 'POST' })
}

export async function markAllInboxRead(fetchFn: typeof fetch): Promise<void> {
  await apiFetch<undefined>(fetchFn, '/api/v1/notifications/inbox/read-all', { method: 'POST' })
}

export async function dismissInboxEntry(fetchFn: typeof fetch, id: string): Promise<boolean> {
  try {
    await apiFetch<undefined>(fetchFn, `/api/v1/notifications/inbox/${id}`, { method: 'DELETE' })
    return true
  } catch (error) {
    // A dead session redirects to login; never swallow that into "not found".
    if (isRedirect(error)) throw error
    return false
  }
}
