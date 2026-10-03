// Story 68.7 (S2): the project tab bar. Labels are messages (Q6: the one intended visible change,
// Spanish tabs under `es`). Endpoints stays hidden for org viewers (Story AC-9 of the project nav:
// its list endpoint needs role >= member).
import { resolve } from '$app/paths'
import { m } from '$lib/paraglide/messages.js'
import type { ProjectPath } from '$lib/app-paths.js'
import type { NavContexts } from '../types.js'
import type { PvItem, SurfaceBuilder } from './define.js'

type Ctx = NavContexts['project']

/** A project tab's path: the project itself, or a section under it. */
export function projectNavHref(projectId: string, suffix: string): ProjectPath {
  return suffix ? `/projects/${projectId}/${suffix}` : `/projects/${projectId}`
}

/** Each tab's section under the project (`''` is the project itself). */
export const PROJECT_TAB_SUFFIX: ReadonlyMap<string, string> = new Map([
  ['project.overview', ''],
  ['project.secrets', 'credentials'],
  ['project.members', 'members'],
  ['project.machine-users', 'machine-users'],
  ['project.services', 'services'],
  ['project.certificates', 'certificates'],
  ['project.domains', 'domains'],
  ['project.endpoints', 'service-endpoints'],
  ['project.status-page', 'status-page'],
])

function tab(
  id: PvItem<Ctx>['id'],
  label: () => string,
  extra: Partial<PvItem<Ctx>> = {}
): PvItem<Ctx> {
  const suffix = PROJECT_TAB_SUFFIX.get(id) ?? ''
  return {
    id,
    label,
    href: (ctx) => resolve(projectNavHref(ctx.projectId, suffix)),
    ...extra,
  }
}

export const projectItems: SurfaceBuilder<'project'> = () => [
  tab('project.overview', () => m.nav_project_overview(), { match: 'exact' }),
  tab('project.secrets', () => m.nav_project_secrets()),
  tab('project.members', () => m.nav_project_members()),
  tab('project.machine-users', () => m.nav_project_machine_users()),
  tab('project.services', () => m.nav_project_services()),
  tab('project.certificates', () => m.nav_project_certificates()),
  tab('project.domains', () => m.nav_project_domains()),
  tab('project.endpoints', () => m.nav_project_endpoints(), {
    when: (ctx) => ctx.orgRole !== 'viewer',
  }),
  tab('project.status-page', () => m.nav_project_status_page()),
]
