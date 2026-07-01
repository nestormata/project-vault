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

export function canSendTestNotification(user: { orgRole: string; mfaEnrolled: boolean }): boolean {
  return ['owner', 'admin'].includes(user.orgRole) && user.mfaEnrolled
}

export type RoutingRoleForm = RoutingRole
