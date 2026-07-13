import { isActiveNavItem } from './nav-model.js'

export type ProjectNavItem = {
  label: string
  href: string
  // AC-9: Overview's own href (`/projects/:id`) has no further path segments, so it needs a
  // strict-equality match — reusing isActiveNavItem's prefix rule for it would also light up
  // Overview on every deeper project screen (e.g. `/projects/:id/credentials`), since every one
  // of those paths starts with the Overview href.
  matchExact: boolean
}

type ProjectNavItemDef = {
  label: string
  suffix: string
  // AC-9: GET /:projectId/service-endpoints and GET /:projectId/alerts
  // (apps/api/src/modules/monitoring/routes.ts) require org role >= member — an org-viewer
  // hitting this tab today gets an uncaught 403 ApiClientError from the page's own loader (which
  // only catches 404), landing on SvelteKit's generic error page with no explanation. Every other
  // project tab's list endpoint is viewer-accessible (confirmed by direct source read across
  // credentials/members/machine-users/services/certificates/domains/status-page), so Endpoints is
  // the only tab that needs gating here.
  hiddenForViewer?: boolean
}

const PROJECT_NAV_ITEM_DEFS: ProjectNavItemDef[] = [
  { label: 'Overview', suffix: '' },
  { label: 'Credentials', suffix: 'credentials' },
  { label: 'Members', suffix: 'members' },
  { label: 'Machine Users', suffix: 'machine-users' },
  { label: 'Services', suffix: 'services' },
  { label: 'Certificates', suffix: 'certificates' },
  { label: 'Domains', suffix: 'domains' },
  { label: 'Endpoints', suffix: 'service-endpoints', hiddenForViewer: true },
  { label: 'Status Page', suffix: 'status-page' },
]

export function projectNavHref(projectId: string, suffix: string): string {
  return suffix ? `/projects/${projectId}/${suffix}` : `/projects/${projectId}`
}

export function getProjectNavItems(projectId: string, orgRole: string): ProjectNavItem[] {
  return PROJECT_NAV_ITEM_DEFS.filter(
    (item) => !(item.hiddenForViewer && orgRole === 'viewer')
  ).map((item) => ({
    label: item.label,
    href: projectNavHref(projectId, item.suffix),
    matchExact: item.suffix === '',
  }))
}

export function isActiveProjectNavItem(item: ProjectNavItem, pathname: string): boolean {
  return item.matchExact ? pathname === item.href : isActiveNavItem(item.href, pathname)
}
