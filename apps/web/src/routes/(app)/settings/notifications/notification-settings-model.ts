import type { RoutingRole } from '@project-vault/shared'

/**
 * MFA recovery alerts are always direct-to-subject (ADR-3.4-06). They must never be
 * offered in the org routing table, which only targets owner/admin/member roles.
 */
export const MFA_DIRECT_USER_ALERT_TYPES = [
  'security.mfa_recovery_used',
  'security.mfa_recovery_codes_regenerated',
] as const

export function isRoutableAlertType(alertType: string): boolean {
  return !(MFA_DIRECT_USER_ALERT_TYPES as readonly string[]).includes(alertType)
}

export function filterRoutableAlertTypes<T extends { alertType: string }>(items: T[]): T[] {
  return items.filter((item) => isRoutableAlertType(item.alertType))
}

/** Gates visibility of admin-only sections (org routing table, test-notification panel). */
export function isAdminRole(orgRole: string): boolean {
  return ['owner', 'admin'].includes(orgRole)
}

export function canSendTestNotification(user: { orgRole: string; mfaEnrolled: boolean }): boolean {
  return isAdminRole(user.orgRole) && user.mfaEnrolled
}

export type RoutingRoleForm = RoutingRole
