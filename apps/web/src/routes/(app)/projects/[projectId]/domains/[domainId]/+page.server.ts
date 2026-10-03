import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { ApiClientError } from '$lib/api/client.js'
import { getDomain } from '$lib/api/domains.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

const ownLoad = (async ({ params, fetch, locals }) => {
  const orgRole = requireUser(locals).orgRole

  try {
    const domain = await getDomain(fetch, params.projectId, params.domainId)
    return { projectId: params.projectId, orgRole, domain, notFound: false as const }
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return { projectId: params.projectId, orgRole, domain: null, notFound: true as const }
    }
    throw error
  }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(
  ownLoad,
  '/(app)/projects/[projectId]/domains/[domainId]',
  'page'
)

export const actions = injectActions('/(app)/projects/[projectId]/domains/[domainId]')
