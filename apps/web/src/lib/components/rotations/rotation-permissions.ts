export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

// Mirrors the server's `minimumRole: 'admin'` gate on initiate/break-glass/complete/resume/abandon
// (apps/api/src/modules/rotation/routes.ts) — UX-only, the server remains the sole boundary.
export const ROTATION_MANAGE_ROLES = ['owner', 'admin'] as const

// Mirrors the server's `minimumRole: 'member'` gate on confirm/fail/retry.
export const ROTATION_CHECKLIST_ACTION_ROLES = ['owner', 'admin', 'member'] as const

export function canManageRotations(orgRole: OrgRole): boolean {
  return (ROTATION_MANAGE_ROLES as readonly string[]).includes(orgRole)
}

export function canActOnChecklist(orgRole: OrgRole): boolean {
  return (ROTATION_CHECKLIST_ACTION_ROLES as readonly string[]).includes(orgRole)
}
