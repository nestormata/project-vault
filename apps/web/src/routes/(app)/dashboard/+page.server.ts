import { ApiClientError } from '$lib/api/client.js'
import { listCertificates } from '$lib/api/certificates.js'
import { getOrgDashboard } from '$lib/api/dashboard.js'
import { listDomains } from '$lib/api/domains.js'
import { getProjectDashboard, listProjects } from '$lib/api/projects.js'
import type { PageServerLoad } from './$types.js'

function isApi404(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 404
}

async function loadProjects(fetch: typeof globalThis.fetch) {
  try {
    return { projects: await listProjects(fetch), vaultSealed: false as const }
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 503) {
      return {
        projects: { items: [] },
        selectedProject: null,
        dashboard: null,
        orgDashboard: null,
        vaultSealed: true as const,
      }
    }
    throw error
  }
}

function nullOn404<T>(promise: Promise<T>): Promise<T | null> {
  return promise.catch((error) => {
    if (isApi404(error)) return null
    throw error
  })
}

function settledValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === 'fulfilled' ? result.value : fallback
}

function settledAssetState<T>(
  result: PromiseSettledResult<T[]>
): { status: 'ready'; count: number } | { status: 'error'; count: 0 } {
  return result.status === 'fulfilled'
    ? { status: 'ready', count: result.value.length }
    : { status: 'error', count: 0 }
}

function projectDashboardRequest(fetch: typeof globalThis.fetch, projectId: string | undefined) {
  return projectId ? nullOn404(getProjectDashboard(fetch, projectId)) : Promise.resolve(null)
}

function assetRequest<T>(
  fetch: typeof globalThis.fetch,
  projectId: string | undefined,
  request: (fetch: typeof globalThis.fetch, projectId: string) => Promise<T[]>
) {
  return projectId ? request(fetch, projectId) : Promise.resolve([])
}

function isMissingProject(
  selectedProject: { id: string } | null,
  result: PromiseSettledResult<unknown>,
  dashboard: unknown
): boolean {
  return selectedProject !== null && result.status === 'fulfilled' && dashboard === null
}

export const load: PageServerLoad = async ({ fetch, url }) => {
  const projectLoad = await loadProjects(fetch)
  if (projectLoad.vaultSealed) return projectLoad

  const { projects } = projectLoad

  // The project list is the access-controlled source of selectable projects. The URL selection
  // is intentionally not persisted in browser storage: a bookmark/revisit preserves it, while a
  // plain /dashboard visit deterministically opens the first currently accessible project.
  const selectedProjectId = url.searchParams.get('projectId')
  const selectedProject =
    projects.items.find((project) => project.id === selectedProjectId) ?? projects.items[0] ?? null
  const projectId = selectedProject?.id

  const orgDashboardPromise = nullOn404(getOrgDashboard(fetch))
  const projectDashboardPromise = projectDashboardRequest(fetch, projectId)
  const certificatesPromise = assetRequest(fetch, projectId, listCertificates)
  const domainsPromise = assetRequest(fetch, projectId, listDomains)

  const [orgResult, dashboardResult, certificatesResult, domainsResult] = await Promise.allSettled([
    orgDashboardPromise,
    projectDashboardPromise,
    certificatesPromise,
    domainsPromise,
  ])

  const orgDashboard = settledValue(orgResult, null)
  const dashboard = settledValue(dashboardResult, null)
  const projectWasNotFound = isMissingProject(selectedProject, dashboardResult, dashboard)
  const effectiveSelectedProject = projectWasNotFound ? null : selectedProject

  return {
    projects,
    selectedProject: effectiveSelectedProject,
    dashboard,
    orgDashboard,
    orgDashboardError: orgResult.status === 'rejected',
    dashboardError: dashboardResult.status === 'rejected',
    alertStatus: dashboard === null ? ('error' as const) : ('ready' as const),
    monitoringAssets: {
      certificates: settledAssetState(certificatesResult),
      domains: settledAssetState(domainsResult),
    },
  }
}
