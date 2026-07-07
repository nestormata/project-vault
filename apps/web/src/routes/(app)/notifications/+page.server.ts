import { fail, error } from '@sveltejs/kit'
import { ApiClientError } from '$lib/api/client.js'
import {
  dismissInboxEntry,
  getNotificationInbox,
  markAllInboxRead,
  markInboxEntryRead,
} from '$lib/api/inbox.js'
import type { Actions, PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ fetch, url }) => {
  const page = Number(url.searchParams.get('page') ?? '1')
  const status = (url.searchParams.get('status') ?? 'all') as 'all' | 'unread' | 'read'

  try {
    // Story 9.3 D8.4: inbox.data is now { items, total, page, limit, hasNext } (previously a
    // bare array) — read .items, not the whole data object, and surface total/hasNext for
    // future pagination UI.
    const inbox = await getNotificationInbox(fetch, { page, limit: 20, status })
    return {
      notifications: inbox.data.items,
      total: inbox.data.total,
      hasNext: inbox.data.hasNext,
      page: inbox.data.page,
      status,
    }
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 403) {
      return { notifications: [], page, status }
    }
    throw error(500, 'Failed to load notifications')
  }
}

export const actions: Actions = {
  markRead: async ({ request, fetch }) => {
    const data = await request.formData()
    const id = String(data.get('id'))
    try {
      await markInboxEntryRead(fetch, id)
    } catch {
      return fail(422, { error: 'Failed to mark notification read' })
    }
    return { success: true }
  },

  markAllRead: async ({ fetch }) => {
    try {
      await markAllInboxRead(fetch)
    } catch {
      return fail(422, { error: 'Failed to mark all notifications read' })
    }
    return { success: true }
  },

  dismiss: async ({ request, fetch }) => {
    const data = await request.formData()
    const id = String(data.get('id'))
    const ok = await dismissInboxEntry(fetch, id)
    if (!ok) return fail(404, { error: 'Notification not found' })
    return { success: true }
  },
}
