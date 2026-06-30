import { fail } from '@sveltejs/kit'
import { NOTIFICATION_ALERT_TYPES } from '@project-vault/shared'
import {
  getNotificationPreferences,
  getOrgNotificationRouting,
  patchNotificationPreferences,
  putOrgNotificationRouting,
  type RoutingItem,
} from '$lib/api/notifications.js'
import { ApiClientError } from '$lib/api/client.js'
import type { Actions, PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ fetch, locals }) => {
  const isAdmin = locals.user ? ['owner', 'admin'].includes(locals.user.orgRole) : false

  const preferences = await getNotificationPreferences(fetch)

  let routing: RoutingItem[] | null = null
  if (isAdmin) {
    try {
      routing = await getOrgNotificationRouting(fetch)
    } catch (error) {
      if (!(error instanceof ApiClientError && error.status === 403)) throw error
    }
  }

  return { preferences, routing, isAdmin }
}

export const actions: Actions = {
  updatePreference: async ({ request, fetch }) => {
    const data = await request.formData()
    const alertType = String(data.get('alertType'))
    const channel = String(data.get('channel'))
    const frequency = String(data.get('frequency'))
    const minSeverity = String(data.get('minSeverity'))

    try {
      await patchNotificationPreferences(fetch, [
        {
          alertType,
          channel: channel as 'email' | 'slack' | 'inbox' | 'none',
          frequency: frequency as 'immediate' | 'digest_daily',
          minSeverity: minSeverity as 'info' | 'warning' | 'critical',
        },
      ])
    } catch {
      return fail(422, { error: 'Failed to update preference' })
    }
    return { success: true }
  },

  updateRouting: async ({ request, fetch }) => {
    const data = await request.formData()
    const routing: RoutingItem[] = NOTIFICATION_ALERT_TYPES.map((alertType) => ({
      alertType,
      routeTo: String(data.get(`routeTo_${alertType}`) ?? 'owner') as RoutingItem['routeTo'],
    }))

    try {
      await putOrgNotificationRouting(fetch, routing)
    } catch {
      return fail(422, { error: 'Failed to update routing' })
    }
    return { success: true }
  },
}
