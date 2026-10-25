import { archiveAuthority } from '@project-vault/shared'

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

/** The caller's role as the project payload reports it (`membership role ?? org role`). */
export type ProjectWithRole = { role?: string | null } | null | undefined

const ROLE_RANK: Record<OrgRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 }

function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && Object.hasOwn(ROLE_RANK, value)
}

/**
 * Story 69.17 (DW-606): mirrors the API's effective project role (Story 4.5 D4). An org owner or
 * admin keeps their org role whatever their row says; anyone else gets the project's role, else
 * their org role (the API's project payload already applies that fallback, so a missing or
 * unrecognized `role` falls back the same way). A missing project (not loaded, or 404) resolves to
 * `viewer`, so write controls stay hidden.
 */
export function effectiveProjectRole(orgRole: OrgRole, project: ProjectWithRole): OrgRole {
  if (orgRole === 'owner' || orgRole === 'admin') return orgRole
  if (project == null) return 'viewer'
  return isOrgRole(project.role) ? project.role : orgRole
}

/** Every project write needs an effective project role of at least `member` (the API's default
 * `minimumProjectRole`). Only gates the controls; the API is the boundary. */
export function canWriteInProject(orgRole: OrgRole, project: ProjectWithRole): boolean {
  return ROLE_RANK[effectiveProjectRole(orgRole, project)] >= ROLE_RANK.member
}

/** Story 69.20 (DW-618): Archive and Unarchive of a project or one of its secrets show exactly when
 * the API allows them (the shared `archiveAuthority` rule: project owner row or org owner, org
 * member+). A missing project hides them. */
export function canArchiveInProject(
  orgRole: OrgRole | undefined,
  project: ProjectWithRole
): boolean {
  return project != null && archiveAuthority(orgRole, project.role) !== null
}
