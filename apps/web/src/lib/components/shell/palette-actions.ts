import { canCreateCredentialInProject } from '$lib/credentials/permissions.js'
import { canCreateProject } from '$lib/components/onboarding/onboarding-logic.js'

// Story 72.5 (P12): the command palette's actions. Authorization comes first: an action the user
// may not perform is never built, so it cannot be shown, selected or leaked through its label. The
// rules reuse the web gates the pages themselves use (the API stays the boundary).

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

/** Where an action goes; the palette maps each to a typed route at selection. */
export type PaletteTarget =
  { to: 'create-project' } | { to: 'audit-log' } | { to: 'new-secret'; projectId: string }

export type PaletteAction = {
  id: string
  label: string
  target: PaletteTarget
}

/** The audit log is owner-only (`settings/audit` load gate). */
const AUDIT_LOG_ROLE: OrgRole = 'owner'

const ORG_ROLES: readonly string[] = ['owner', 'admin', 'member', 'viewer']

export function asOrgRole(value: unknown): OrgRole | null {
  return typeof value === 'string' && ORG_ROLES.includes(value) ? (value as OrgRole) : null
}

/** Actions that need no project: "Create project", "Go to Audit log". */
export function staticActions(orgRole: OrgRole | null): PaletteAction[] {
  if (orgRole === null) return []
  const actions: PaletteAction[] = []
  if (canCreateProject(orgRole)) {
    actions.push({
      id: 'create-project',
      label: 'Create project',
      target: { to: 'create-project' },
    })
  }
  if (orgRole === AUDIT_LOG_ROLE) {
    actions.push({ id: 'go-audit-log', label: 'Go to Audit log', target: { to: 'audit-log' } })
  }
  return actions
}

export type KnownProject = {
  id: string
  name: string
  /** The caller's effective role in the project, as the project payload reports it. */
  role: string | null | undefined
  isArchived?: boolean
}

/** "New secret in X": only for a project the caller may add secrets to, and not an archived one. */
export function projectActions(orgRole: OrgRole | null, projects: KnownProject[]): PaletteAction[] {
  if (orgRole === null) return []
  return projects
    .filter((project) => project.isArchived !== true)
    .filter((project) => canCreateCredentialInProject(orgRole, { role: project.role }))
    .map((project) => ({
      id: `new-secret-${project.id}`,
      label: `New secret in ${project.name}`,
      target: { to: 'new-secret' as const, projectId: project.id },
    }))
}

/** Case-insensitive substring match on the label; an empty query keeps everything. */
export function filterActions(actions: PaletteAction[], query: string): PaletteAction[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return actions
  return actions.filter((action) => action.label.toLowerCase().includes(needle))
}
