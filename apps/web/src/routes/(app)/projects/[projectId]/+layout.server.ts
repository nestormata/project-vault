import { withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { ApiClientError } from '$lib/api/client.js'
import { getProject } from '$lib/api/projects.js'
import { requireUser } from '$lib/server/require-user.js'
import type { LayoutServerLoad } from './$types.js'

// 12-1 AC-5/AC-8/AC-10: shared layout for every /projects/:id/** screen — supplies the persistent
// sub-nav (ProjectNav) with the data it needs (org role for tab gating, isArchived for the badge)
// without touching any of the 8 existing sub-pages' own loaders. Degrades to `project: null` on a
// 404/foreign-org project (same convention as every other project-scoped loader in this tree) so
// the sub-nav still renders its static tab set — each sub-page independently handles its own
// not-found presentation, unaffected by this addition.
const ownLoad = (async ({ params, fetch, locals }) => {
  const orgRole = requireUser(locals).orgRole

  try {
    const project = await getProject(fetch, params.projectId)
    return { projectId: params.projectId, orgRole, project }
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      // `notFound: true` lets `withInjectedLoad` skip contribution loads on a 404 (Story 69.1 Q2).
      return { projectId: params.projectId, orgRole, project: null, notFound: true as const }
    }
    throw error
  }
}) satisfies LayoutServerLoad

export const load: LayoutServerLoad = withInjectedLoad(
  ownLoad,
  '/(app)/projects/[projectId]',
  'layout'
)
