export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

// Mirrors the server's `minimumRole: 'admin'` gate on every machine-user mutation route
// (apps/api/src/modules/machine-users/routes.ts: create/issue-key/revoke-key/rotate/
// emergency-revoke/deactivate) — UX-only, the server remains the sole enforcement boundary.
export const MACHINE_USER_MANAGE_ROLES = ['owner', 'admin'] as const

export function canManageMachineUsers(orgRole: OrgRole): boolean {
  return (MACHINE_USER_MANAGE_ROLES as readonly string[]).includes(orgRole)
}
