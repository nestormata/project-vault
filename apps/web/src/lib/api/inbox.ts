import { apiFetch } from './client.js'

export type UserMeResponse = {
  userId: string
  orgId: string
  orgRole: 'owner' | 'admin' | 'member' | 'viewer'
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

export type InboxListResponse = {
  data: InboxEntry[]
  page: number
  limit: number
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
  const response = await fetchFn(`/api/v1/notifications/inbox${suffix}`, {
    credentials: 'include',
  })
  const body = (await response.json().catch(() => null)) as InboxListResponse | null
  if (!response.ok || !body) {
    throw new Error('Failed to load notification inbox')
  }
  return body
}

export async function markInboxEntryRead(fetchFn: typeof fetch, id: string) {
  const response = await fetchFn(`/api/v1/notifications/inbox/${id}/read`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!response.ok && response.status !== 204) {
    throw new Error('Failed to mark notification read')
  }
}

export async function markAllInboxRead(fetchFn: typeof fetch) {
  const response = await fetchFn('/api/v1/notifications/inbox/read-all', {
    method: 'POST',
    credentials: 'include',
  })
  if (!response.ok && response.status !== 204) {
    throw new Error('Failed to mark all notifications read')
  }
}

export async function dismissInboxEntry(fetchFn: typeof fetch, id: string) {
  const response = await fetchFn(`/api/v1/notifications/inbox/${id}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  return response.ok || response.status === 204
}
