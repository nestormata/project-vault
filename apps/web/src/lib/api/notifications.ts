import type {
  NotificationChannel,
  NotificationFrequency,
  NotificationSeverity,
  RoutingRole,
} from '@project-vault/shared'
import { apiFetch } from './client.js'

export type PreferenceItem = {
  alertType: string
  channel: NotificationChannel
  frequency: NotificationFrequency
  minSeverity: NotificationSeverity
}

export type RoutingItem = {
  alertType: string
  routeTo: RoutingRole
}

export function getNotificationPreferences(fetchFn: typeof fetch) {
  return apiFetch<PreferenceItem[]>(fetchFn, '/api/v1/users/me/notification-preferences')
}

export function patchNotificationPreferences(
  fetchFn: typeof fetch,
  items: Array<{
    alertType: string
    channel: NotificationChannel | 'none'
    frequency: NotificationFrequency
    minSeverity: NotificationSeverity
  }>
) {
  return apiFetch<PreferenceItem[]>(fetchFn, '/api/v1/users/me/notification-preferences', {
    method: 'PATCH',
    body: JSON.stringify(items),
  })
}

export function getOrgNotificationRouting(fetchFn: typeof fetch) {
  return apiFetch<RoutingItem[]>(fetchFn, '/api/v1/org/notification-routing')
}

export function putOrgNotificationRouting(fetchFn: typeof fetch, items: RoutingItem[]) {
  return apiFetch<RoutingItem[]>(fetchFn, '/api/v1/org/notification-routing', {
    method: 'PUT',
    body: JSON.stringify(items),
  })
}

export type NotificationTestResult = {
  email: 'delivered' | 'failed' | 'not_configured'
  slack: 'delivered' | 'failed' | 'not_configured'
}

export function postAdminNotificationTest(fetchFn: typeof fetch) {
  return apiFetch<NotificationTestResult>(fetchFn, '/api/v1/admin/notifications/test', {
    method: 'POST',
  })
}
