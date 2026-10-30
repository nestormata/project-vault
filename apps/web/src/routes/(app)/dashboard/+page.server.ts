import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { ApiClientError } from '$lib/api/client.js'
import { listCertificates } from '$lib/api/certificates.js'
import {
  getDashboardAttention,
  getOrgDashboard,
  type DashboardAttentionState,
} from '$lib/api/dashboard.js'
import { listDomains } from '$lib/api/domains.js'
import { getProjectDashboard, listAllProjects } from '$lib/api/projects.js'
import type { PageServerLoad } from './$types.js'

function isApi404(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 404
}

async function loadProjects(fetch: typeof globalThis.fetch) {
  try {
    return { projects: await listAllProjects(fetch), vaultSealed: false as const }
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

/** A failed read: an API error response, or a network failure surfacing as a fetch TypeError. */
function isReadFailure(error: unknown): boolean {
  return error instanceof ApiClientError || error instanceof TypeError
}

/**
 * Story 72-12: a failed attention read is converted to `{ status: 'error' }` where the promise is
 * created (it renders as no card, never as a failed page), so no code path can leave it unhandled.
 * Anything that is not a failed read, such as a SvelteKit redirect for a session that died
 * mid-load, is rethrown so the page still redirects.
 */
function attentionState(fetch: typeof globalThis.fetch): Promise<DashboardAttentionState> {
  return getDashboardAttention(fetch).then(
    (attention) => ({ status: 'ready' as const, ...attention }),
    (error) => {
      if (isReadFailure(error)) return { status: 'error' as const }
      throw error
    }
  )
}

function projectDashboardRequest(fetch: typeof globalThis.fetch, projectId: string | undefined) {
  return projectId ? nullOn404(getProjectDashboard(fetch, projectId)) : Promise.resolve(null)
}

type AssetCardState =
  | { status: 'ready'; count: number }
  | { status: 'forbidden'; count: 0 }
  | { status: 'error'; count: 0 }

function isApi403(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 403
}

/**
 * Story 72-20: an asset read is converted to a card state where the promise is created, before the
 * load's first `await`. A rejection handled only in the return would be unhandled while the other
 * reads are in flight, and Node ends the web process on an unhandled rejection. An organization
 * `viewer` gets a 403 here, which is a role limit (`forbidden`), not a failure (`error`).
 */
function assetState<T>(
  fetch: typeof globalThis.fetch,
  projectId: string | undefined,
  request: (fetch: typeof globalThis.fetch, projectId: string) => Promise<T[]>
): Promise<AssetCardState> {
  if (!projectId) return Promise.resolve({ status: 'ready', count: 0 })
  return request(fetch, projectId).then(
    (items): AssetCardState => ({ status: 'ready', count: items.length }),
    (error): AssetCardState =>
      isApi403(error) ? { status: 'forbidden', count: 0 } : { status: 'error', count: 0 }
  )
}

function isMissingProject(
  selectedProject: { id: string } | null,
  result: PromiseSettledResult<unknown>,
  dashboard: unknown
): boolean {
  return selectedProject !== null && result.status === 'fulfilled' && dashboard === null
}

const ownLoad = (async ({ fetch, url }) => {
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
  const certificates = assetState(fetch, projectId, listCertificates)
  const domains = assetState(fetch, projectId, listDomains)
  const attentionPromise = attentionState(fetch)

  const [[orgResult, dashboardResult], attention] = await Promise.all([
    Promise.allSettled([orgDashboardPromise, projectDashboardPromise]),
    attentionPromise,
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
    attention,
    orgDashboardError: orgResult.status === 'rejected',
    dashboardError: dashboardResult.status === 'rejected',
    alertStatus: dashboard === null ? ('error' as const) : ('ready' as const),
    monitoringAssets: {
      // Leave these promises unresolved so SvelteKit streams the card data after the page shell
      // renders. Each promise converts its own failure into a card state where it is created, so
      // the cards degrade independently.
      certificates,
      domains,
    },
  }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(ownLoad, '/(app)/dashboard', 'page')

export const actions = injectActions('/(app)/dashboard')
