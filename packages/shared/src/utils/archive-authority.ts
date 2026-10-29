/** Which path lets a caller archive or unarchive a project or a secret (recorded on the audit row). */
export type ArchiveAuthority = 'project_owner' | 'org_owner'

/**
 * Story 69.20 (DW-618): who may archive or unarchive a project or one of its secrets. The API
 * handlers and the web controls both call this, so the control shows exactly when the API allows.
 *
 * - `orgRole`: the caller's org role. Only `member`, `admin` and `owner` qualify: an org viewer is
 *   read-only everywhere (the routes' org floor is `member`).
 * - `projectRole`: the caller's own project membership role. The web may pass the project
 *   payload's `role` (`membership ?? org role`): with no row it equals the org role, and only an
 *   org owner can then be `owner`, which this rule allows anyway.
 *
 * An org admin without the owner row is refused: archiving is the owner's call (Story 4.4
 * ADR-4.4-05), unlike the member-management rule.
 */
export function archiveAuthority(
  orgRole: string | null | undefined,
  projectRole: string | null | undefined
): ArchiveAuthority | null {
  if (orgRole !== 'owner' && orgRole !== 'admin' && orgRole !== 'member') return null
  if (projectRole === 'owner') return 'project_owner'
  if (orgRole === 'owner') return 'org_owner'
  return null
}

/** Which path lets a caller edit a project's name, description and links (recorded on the audit row). */
export type ProjectEditAuthority = ArchiveAuthority | 'org_admin'

/**
 * Story 72-9: who may edit a project (PATCH). Wider than `archiveAuthority` by one rule: an org
 * admin may edit without holding the owner row. Delete and restore keep `archiveAuthority`.
 * An org viewer (or an unknown role) is refused, as everywhere else.
 */
export function projectEditAuthority(
  orgRole: string | null | undefined,
  projectRole: string | null | undefined
): ProjectEditAuthority | null {
  const viaArchiveRule = archiveAuthority(orgRole, projectRole)
  if (viaArchiveRule !== null) return viaArchiveRule
  return orgRole === 'admin' ? 'org_admin' : null
}
