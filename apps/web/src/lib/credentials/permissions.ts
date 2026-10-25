import { canCreateCredential } from '$lib/components/onboarding/onboarding-logic.js'
import { canWriteInProject, type ProjectWithRole } from '$lib/projects/project-write-access.js'

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

/** Story 69.17 (DW-606): adding a secret (or editing project tags) needs a creator org role AND an
 * effective project role of member+, as the API enforces. */
export function canCreateCredentialInProject(orgRole: OrgRole, project: ProjectWithRole): boolean {
  return canCreateCredential(orgRole) && canWriteInProject(orgRole, project)
}

export const CREDENTIAL_IMPORT_ROLES = ['owner', 'admin'] as const

export function canImportCredentials(orgRole: OrgRole): boolean {
  return (CREDENTIAL_IMPORT_ROLES as readonly string[]).includes(orgRole)
}
