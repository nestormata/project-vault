import type { ProjectPath } from '$lib/app-paths.js'
import { renderSurface } from '$lib/navigation/build-surface.js'
import { PROJECT_TAB_SUFFIX, projectNavHref } from '$lib/navigation/surfaces/project.js'
import { isActiveNavItem } from './nav-model.js'

export type ProjectNavItem = {
  label: string
  href: ProjectPath
  // AC-9: Overview's own href (`/projects/:id`) has no further path segments, so it needs a
  // strict-equality match — reusing isActiveNavItem's prefix rule for it would also light up
  // Overview on every deeper project screen (e.g. `/projects/:id/credentials`), since every one
  // of those paths starts with the Overview href.
  matchExact: boolean
}

export { projectNavHref }

// Story 68.7 AC-1: a compatibility facade over the `project` surface's builder (nav as data), with
// the EMPTY delta. AC-9 of the project nav still holds: GET /:projectId/service-endpoints and
// GET /:projectId/alerts need org role >= member, so the Endpoints tab carries a `when` that hides
// it from org viewers (every other tab's list endpoint is viewer-accessible). Labels are messages
// now (Story 68.7 Q6; English text unchanged).
export function getProjectNavItems(projectId: string, orgRole: string): ProjectNavItem[] {
  return renderSurface('project', { projectId, orgRole, pathname: '' }, { delta: {} }).map(
    (node) => {
      const suffix = PROJECT_TAB_SUFFIX.get(node.id) ?? ''
      return {
        label: node.label,
        href: projectNavHref(projectId, suffix),
        matchExact: suffix === '',
      }
    }
  )
}

export function isActiveProjectNavItem(item: ProjectNavItem, pathname: string): boolean {
  return item.matchExact ? pathname === item.href : isActiveNavItem(item.href, pathname)
}
