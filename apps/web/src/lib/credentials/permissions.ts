export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

export const CREDENTIAL_IMPORT_ROLES = ['owner', 'admin'] as const

export function canImportCredentials(orgRole: OrgRole): boolean {
  return (CREDENTIAL_IMPORT_ROLES as readonly string[]).includes(orgRole)
}
