export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

// Story 6.4 AC-I1/Background: every services/certificates/domains/service-endpoints mutation
// (create/edit/delete) and alert-snooze requires member+ — mirrors
// `$lib/credentials/permissions.ts`'s canImportCredentials convention (conditionally render, not
// disable, restricted controls).
export const MONITORED_ASSET_MANAGE_ROLES = ['member', 'admin', 'owner'] as const

// Story 6.4 Background/ADR-6.2-04: dismissing a monitoring alert requires admin+ specifically —
// NOT member+ like every other mutation in this module. A member must never see a dismiss
// control that would 403 on click.
export const ALERT_DISMISS_ROLES = ['admin', 'owner'] as const

export function canManageMonitoredAssets(orgRole: OrgRole): boolean {
  return (MONITORED_ASSET_MANAGE_ROLES as readonly string[]).includes(orgRole)
}

export function canDismissAlert(orgRole: OrgRole): boolean {
  return (ALERT_DISMISS_ROLES as readonly string[]).includes(orgRole)
}
