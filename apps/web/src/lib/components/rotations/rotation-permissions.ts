import { canWriteInProject, type ProjectWithRole } from '$lib/projects/project-write-access.js'

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

// Mirrors the server's `minimumRole: 'admin'` gate on initiate/break-glass/complete/resume/abandon
// (apps/api/src/modules/rotation/routes.ts) — UX-only, the server remains the sole boundary.
export const ROTATION_MANAGE_ROLES = ['owner', 'admin'] as const

// Mirrors the server's `minimumRole: 'member'` gate on confirm/fail/retry, plus its default
// `minimumProjectRole: 'member'` (Story 69.17): a project viewer cannot act on the checklist.
export const ROTATION_CHECKLIST_ACTION_ROLES = ['owner', 'admin', 'member'] as const

export function canManageRotations(orgRole: OrgRole): boolean {
  return (ROTATION_MANAGE_ROLES as readonly string[]).includes(orgRole)
}

export function canActOnChecklist(orgRole: OrgRole, project: ProjectWithRole): boolean {
  return (
    (ROTATION_CHECKLIST_ACTION_ROLES as readonly string[]).includes(orgRole) &&
    canWriteInProject(orgRole, project)
  )
}
