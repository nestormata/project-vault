import { fail, error } from '@sveltejs/kit'
import { ApiClientError } from '$lib/api/client.js'
import {
  dismissInboxEntry,
  getNotificationInbox,
  markAllInboxRead,
  markInboxEntryRead,
} from '$lib/api/inbox.js'
import { extendKeyDormancy, revokeApiKey } from '$lib/api/machine-users.js'
import { dismissSecurityAlert, listOrgSecurityAlerts } from '$lib/api/security-alerts.js'
import { toDormancyAlertViews, type DormancyAlertView } from '$lib/notifications/dormancy-alerts.js'
import { requireUser } from '$lib/server/require-user.js'
import type { Actions, PageServerLoad } from './$types.js'

const DORMANCY_MANAGE_ROLES = new Set(['owner', 'admin'])

// AC-4 — the org's dormancy alerts (`machine_key.dormant` rows in `security_alerts`) are org-wide
// and owner/admin-only per the API's own `allowedRoles` gate, unlike this page's existing personal
// inbox notifications. A non-admin viewer/member simply sees none, matching the API's own access
// boundary rather than surfacing a 403.
async function loadDormancyAlerts(
  fetchFn: typeof fetch,
  orgRole: string
): Promise<DormancyAlertView[]> {
  if (!DORMANCY_MANAGE_ROLES.has(orgRole)) return []
  try {
    const alerts = await listOrgSecurityAlerts(fetchFn, { status: 'all' })
    return toDormancyAlertViews(alerts.items)
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 403) return []
    throw err
  }
}

export const load: PageServerLoad = async ({ fetch, url, locals }) => {
  const page = Number(url.searchParams.get('page') ?? '1')
  const status = (url.searchParams.get('status') ?? 'all') as 'all' | 'unread' | 'read'
  const orgRole = requireUser(locals).orgRole

  let notifications: Awaited<ReturnType<typeof getNotificationInbox>>['data'] = []
  let inboxPage = page
  try {
    const inbox = await getNotificationInbox(fetch, { page, limit: 20, status })
    notifications = inbox.data
    inboxPage = inbox.page
  } catch (err) {
    if (!(err instanceof ApiClientError && err.status === 403)) {
      throw error(500, 'Failed to load notifications')
    }
  }

  const dormancyAlerts = await loadDormancyAlerts(fetch, orgRole)

  return { notifications, page: inboxPage, status, orgRole, dormancyAlerts }
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

  // AC-4: dismiss a machine_key.dormant security alert (distinct from the personal-inbox
  // `dismiss` action above — this operates on the org-wide `security_alerts` row via D9's generic
  // dismiss endpoint, not the per-user notification-inbox entry).
  dismissDormancyAlert: async ({ request, fetch }) => {
    const data = await request.formData()
    const alertId = String(data.get('alertId'))
    const reason = String(data.get('reason') ?? '').trim()
    if (!reason) return fail(422, { error: 'A reason is required to dismiss this alert.' })
    try {
      await dismissSecurityAlert(fetch, alertId, reason)
    } catch {
      return fail(422, { error: 'Failed to dismiss dormancy alert' })
    }
    return { success: true }
  },

  extendDormancy: async ({ request, fetch }) => {
    const data = await request.formData()
    const machineUserId = String(data.get('machineUserId'))
    const keyId = String(data.get('keyId'))
    const days = Number(data.get('days'))
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return fail(422, { error: 'Days must be an integer between 1 and 365.' })
    }
    try {
      await extendKeyDormancy(fetch, machineUserId, keyId, days)
    } catch {
      return fail(422, { error: 'Failed to extend dormancy snooze' })
    }
    return { success: true }
  },

  revokeDormantKey: async ({ request, fetch }) => {
    const data = await request.formData()
    const machineUserId = String(data.get('machineUserId'))
    const keyId = String(data.get('keyId'))
    try {
      await revokeApiKey(fetch, machineUserId, keyId)
    } catch {
      return fail(422, { error: 'Failed to revoke key' })
    }
    return { success: true }
  },
}
