import { fail } from '@sveltejs/kit'
import { NOTIFICATION_ALERT_TYPES } from '@project-vault/shared'
import {
  getNotificationPreferences,
  getOrgNotificationRouting,
  patchNotificationPreferences,
  postAdminNotificationTest,
  putOrgNotificationRouting,
  type RoutingItem,
} from '$lib/api/notifications.js'
import { ApiClientError } from '$lib/api/client.js'
import {
  canSendTestNotification,
  filterRoutableAlertTypes,
  isAdminRole,
  isRoutableAlertType,
} from './notification-settings-model.js'
import type { Actions, PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ fetch, locals }) => {
  const isAdmin = locals.user ? isAdminRole(locals.user.orgRole) : false
  const canSendTest = locals.user ? canSendTestNotification(locals.user) : false

  const preferences = await getNotificationPreferences(fetch)

  let routing: RoutingItem[] | null = null
  if (isAdmin) {
    try {
      routing = filterRoutableAlertTypes(await getOrgNotificationRouting(fetch))
    } catch (error) {
      if (!(error instanceof ApiClientError && error.status === 403)) throw error
    }
  }

  return { preferences, routing, isAdmin, canSendTest }
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
    const routing: RoutingItem[] = NOTIFICATION_ALERT_TYPES.filter(isRoutableAlertType).map(
      (alertType) => ({
        alertType,
        routeTo: String(data.get(`routeTo_${alertType}`) ?? 'owner') as RoutingItem['routeTo'],
      })
    )

    try {
      await putOrgNotificationRouting(fetch, routing)
    } catch {
      return fail(422, { error: 'Failed to update routing' })
    }
    return { success: true }
  },

  sendTest: async ({ locals, fetch }) => {
    if (!locals.user || !canSendTestNotification(locals.user)) {
      return fail(403, { error: 'Only MFA-enrolled owners/admins can send a test notification' })
    }

    try {
      const result = await postAdminNotificationTest(fetch)
      return { testResult: result }
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 429) {
        return fail(429, {
          error: 'Test notification rate limit reached — try again in a few minutes',
        })
      }
      // Surfaced to the admin as a generic message (avoid leaking backend internals),
      // but log the real cause server-side — this action exists specifically to
      // diagnose SMTP/Slack delivery problems, so silently discarding the actual
      // error here would defeat its purpose when something is genuinely broken.
      process.stderr.write(
        `${JSON.stringify({
          eventType: 'web.send_test_notification_failed',
          error:
            error instanceof ApiClientError
              ? `ApiClientError status=${error.status}`
              : error instanceof Error
                ? error.message
                : String(error),
        })}\n`
      )
      return fail(422, { error: 'Failed to send test notification' })
    }
  },
}
